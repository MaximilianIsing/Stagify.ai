import express from 'express';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs';
import https from 'https';
import FormData from 'form-data';
import { GoogleGenerativeAI } from "@google/generative-ai";
import OpenAI from 'openai';
import sharp from "sharp";
import cors from 'cors';
import { promptMatrix } from './promptMatrix.js';
import { blueprintTo3D } from './cad-handling.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Function to log prompts to CSV file
function logPromptToFile(promptText, roomType, furnitureStyle, additionalPrompt, removeFurniture, userRole, userReferralSource, userEmail, req) {
  try {
    const timestamp = new Date().toISOString();
    const ipAddress = req ? (req.ip || req.connection.remoteAddress || 'unknown') : 'unknown';
    
    // Escape CSV fields that contain commas, quotes, or newlines
    function escapeCSVField(field) {
      if (field === null || field === undefined) return '';
      const str = String(field);
      if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    }
    
    // Create CSV row
    const csvRow = [
      escapeCSVField(timestamp),
      escapeCSVField(roomType),
      escapeCSVField(furnitureStyle),
      escapeCSVField(additionalPrompt || ''),
      escapeCSVField(removeFurniture),
      escapeCSVField(userRole || 'unknown'),
      escapeCSVField(userReferralSource || 'unknown'),
      escapeCSVField(userEmail || 'unknown'),
      escapeCSVField(ipAddress)
    ].join(',') + '\n';
    
    // Use mounted disk on Render, project data folder locally
    let logDir;
    
    if (process.env.RENDER && fs.existsSync('/data')) {
      // Use Render's mounted disk
      logDir = '/data';
      console.log('Using Render persistent disk');
    } else {
      // Use project data folder for local development
      logDir = path.join(__dirname, 'data');
      
      // Create data directory if it doesn't exist
      if (!fs.existsSync(logDir)) {
        try {
          fs.mkdirSync(logDir, { recursive: true });
          console.log('Created local data directory successfully');
        } catch (error) {
          console.log('Error: Cannot create data directory, using project root');
          logDir = __dirname;
        }
      }
    }

    const logFile = path.join(logDir, 'prompt_logs.csv');
    
    // Check if file exists to add header if it's a new file
    const fileExists = fs.existsSync(logFile);
    
    if (!fileExists) {
      // Create new file with header and first row
      const header = 'timestamp,roomType,furnitureStyle,additionalPrompt,removeFurniture,userRole,referralSource,email,ipAddress\n';
      fs.writeFileSync(logFile, header + csvRow);
    } else {
      // Append to existing file
      fs.appendFile(logFile, csvRow, (err) => {
        if (err) {
          console.error('Error writing to prompt log:', err);
        }
      });
    }
  } catch (error) {
    console.error('Error in logPromptToFile:', error);
  }
}

// Global variable to track prompt count
let promptCount = 0;

// Global variable to track contact count
let contactCount = 0;

// Function to initialize prompt count from CSV file
function initializePromptCount() {
  try {
    let logDir;
    
    if (process.env.RENDER && fs.existsSync('/data')) {
      // Use Render's mounted disk
      logDir = '/data';
    } else {
      // Use project data folder for local development
      logDir = path.join(__dirname, 'data');
    }

    const logFile = path.join(logDir, 'prompt_logs.csv');
    
    if (fs.existsSync(logFile)) {
      const fileContent = fs.readFileSync(logFile, 'utf8');
      
      // Count rows that start with a timestamp (ISO format)
      // Each valid CSV row starts with a timestamp like "2024-01-01T12:34:56"
      const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/gm;
      const matches = fileContent.match(timestampPattern);
      promptCount = matches ? matches.length : 0;
      console.log('Prompt count successfully initialized from file:', promptCount);
    } else {
      console.log('No prompt log file found, starting with count 0');
      promptCount = 0;
    }
  } catch (error) {
    console.error('Error initializing prompt count:', error);
    promptCount = 0;
  }
}

// Function to initialize contact count from CSV file
function initializeContactCount() {
  try {
    let logDir;
    
    if (process.env.RENDER && fs.existsSync('/data')) {
      // Use Render's mounted disk
      logDir = '/data';
    } else {
      // Use project data folder for local development
      logDir = path.join(__dirname, 'data');
    }

    const logFile = path.join(logDir, 'contact_logs.csv');
    
    if (fs.existsSync(logFile)) {
      const fileContent = fs.readFileSync(logFile, 'utf8');
      
      // Count rows that start with a timestamp (ISO format)
      // Each valid CSV row starts with a timestamp like "2024-01-01T12:34:56"
      const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/gm;
      const matches = fileContent.match(timestampPattern);
      contactCount = matches ? matches.length : 0;
      console.log('Contact count successfully initialized from file:', contactCount);
    } else {
      console.log('No contact log file found, starting with count 0');
      contactCount = 0;
    }
  } catch (error) {
    console.error('Error initializing contact count:', error);
    contactCount = 0;
  }
}

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
// Configure CORS to only allow specific origins
const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps, Postman, or same-origin requests)
    if (!origin) {
      return callback(null, true);
    }
    
    // List of allowed origins
    const allowedOrigins = [
      'https://stagify.ai',
      'http://localhost:3000',
      'http://localhost',
      'http://127.0.0.1:3000',
      'http://127.0.0.1'
    ];
    
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
};

app.use(cors(corsOptions));
app.use(express.json({ limit: '50mb' })); // Increased limit to handle conversation history with images
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    console.error('JSON parsing error:', err.message);
    console.error('Request body size:', req.headers['content-length'], 'bytes');
    return res.status(400).json({ error: 'Invalid JSON or request too large' });
  }
  if (err.type === 'entity.too.large') {
    console.error('Request entity too large:', err.message);
    console.error('Request body size:', req.headers['content-length'], 'bytes');
    console.error('Limit:', err.limit, 'bytes');
    return res.status(413).json({ error: 'Request entity too large', limit: err.limit });
  }
  next(err);
});
app.use(express.static('public'));

// Explicit routes for SEO files to ensure they're always accessible
app.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  res.sendFile(path.join(__dirname, 'public', 'robots.txt'));
});

app.get('/sitemap.xml', (req, res) => {
  res.type('application/xml');
  res.sendFile(path.join(__dirname, 'public', 'sitemap.xml'));
});

// Configure multer for file uploads (images)
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only PNG, JPG, JPEG, and WebP files are allowed'));
    }
  }
});

// Configure multer for PDF uploads
const pdfUpload = multer({
  storage: storage,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf')) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'));
    }
  }
});

// Configure multer for chat file uploads (images, PDFs, text files)
const chatUpload = multer({
  storage: storage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB limit per file
    fieldSize: 50 * 1024 * 1024, // 50MB limit for form fields (for conversation history with base64 images)
  },
  fileFilter: (req, file, cb) => {
    // Allow all files - let the AI handle unsupported file types
    cb(null, true);
  }
});

// External PDF processing server URL
const PDF_PROCESSING_SERVER = 'https://stagify-project-imagination.onrender.com';

// Debug mode - check environment variable first, then fall back to debug.txt
let DEBUG_MODE = false;
try {
  // Try environment variable first (Render), then fall back to local file
  let debugValue = process.env.DEBUG;
  if (debugValue === undefined) {
    const debugFile = path.join(__dirname, 'debug.txt');
    if (fs.existsSync(debugFile)) {
      debugValue = fs.readFileSync(debugFile, 'utf8').trim();
    }
  }
  if (debugValue !== undefined) {
    DEBUG_MODE = debugValue.toLowerCase() === 'true';
    console.log(`Debug mode: ${DEBUG_MODE ? 'ENABLED' : 'DISABLED'}`);
  }
} catch (error) {
  console.error('Error reading debug configuration:', error.message);
  DEBUG_MODE = false;
}

// Memory storage for AI chat - per user
function getMemoriesFile() {
  const logDir = process.env.RENDER && fs.existsSync('/data') ? '/data' : path.join(__dirname, 'data');
  return path.join(logDir, 'memories.json');
}

function loadAllMemories() {
  try {
    const file = getMemoriesFile();
    if (fs.existsSync(file)) {
      const data = fs.readFileSync(file, 'utf8').trim();
      // If file is empty or only whitespace, initialize it
      if (!data || data === '') {
        const initialized = {};
        fs.writeFileSync(file, JSON.stringify(initialized, null, 2));
        return initialized;
      }
      return JSON.parse(data);
    } else {
      // File doesn't exist, create it with empty object
      const logDir = path.dirname(file);
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
      const initialized = {};
      fs.writeFileSync(file, JSON.stringify(initialized, null, 2));
      return initialized;
    }
  } catch (error) {
    console.error('Error loading memories:', error);
    // If JSON is invalid, reinitialize the file
    try {
      const file = getMemoriesFile();
      const logDir = path.dirname(file);
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
      const initialized = {};
      fs.writeFileSync(file, JSON.stringify(initialized, null, 2));
      return initialized;
    } catch (initError) {
      console.error('Error initializing memories file:', initError);
      return {};
    }
  }
}

function loadMemories(userId) {
  const allMemories = loadAllMemories();
  return allMemories[userId] || [];
}

function saveMemories(userId, memories) {
  try {
    const file = getMemoriesFile();
    const logDir = path.dirname(file);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    
    const allMemories = loadAllMemories();
    allMemories[userId] = memories;
    fs.writeFileSync(file, JSON.stringify(allMemories, null, 2));
    console.log(`✓ Successfully saved ${memories.length} memories for user: ${userId} to ${file}`);
    
    if (DEBUG_MODE) {
      console.log('All memories structure:', JSON.stringify(allMemories, null, 2));
    }
  } catch (error) {
    console.error('✗ Error saving memories:', error);
    console.error('Error details:', error.stack);
    console.error('File path:', getMemoriesFile());
    console.error('User ID:', userId);
    console.error('Memories to save:', JSON.stringify(memories, null, 2));
  }
}

// Helper function to get appropriate temperature for a model
// gpt-5-mini only supports temperature 1 (default), other models can use 0.7
function getTemperatureForModel(model) {
  if (model && model.includes('gpt-5')) {
    return 1; // gpt-5-mini only supports default temperature (1)
  }
  return 0.7; // Default for other models
}

// Helper function to map GPT model selection to Gemini image model
// Fast (gpt-4o-mini) → gemini-2.5-flash-image-preview
// Pro (gpt-5-mini) → gemini-3-pro-image-preview
function getGeminiImageModel(gptModel) {
  if (gptModel && gptModel.includes('gpt-5')) {
    return 'gemini-3-pro-image-preview'; // Pro model
  }
  return 'gemini-2.5-flash-image-preview'; // Fast model (default)
}

function getUserIdentifier(req) {
  // Try to get userId from request body
  if (req.body && req.body.userId) {
    return req.body.userId;
  }
  
  // Try to get email from request body
  if (req.body && req.body.userEmail && req.body.userEmail !== 'unknown') {
    return req.body.userEmail;
  }
  
  // Generate a user ID based on IP address (for anonymous users)
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  // Create a simple hash-like identifier from IP
  return `user_${ip.replace(/\./g, '_').replace(/:/g, '_')}`;
}

async function evaluateMemoryActions(userMessage, aiResponse, currentMemories, model = 'gpt-4o-mini') {
  try {
    if (!openai) {
      console.error('OpenAI not initialized, cannot evaluate memory actions');
      return { stores: [], forgets: [] };
    }
    
    // Build current memories list for context
    let memoriesContext = '';
    if (currentMemories && currentMemories.length > 0) {
      memoriesContext = '\n\nCurrent stored memories:\n';
      currentMemories.forEach((memory, index) => {
        memoriesContext += `${index + 1}. [ID: ${memory.id}] ${memory.content}\n`;
      });
    }
    
    const prompt = `You are a memory management system. Analyze the following conversation and determine if any memory actions should be taken.

User message: "${userMessage}"
AI response: "${aiResponse}"${memoriesContext}

You can perform two types of actions:
1. STORE: Store new important information as a permanent memory (you can store MULTIPLE memories from one message)
2. FORGET: Delete an existing memory that is no longer relevant, incorrect, or the user wants forgotten

IMPORTANT - Only store LONG-TERM preferences and information:
- DO store: Long-term preferences (e.g., "User prefers modern design style", "User likes minimalist furniture", "User is a real estate agent")
- DO store: Personal context that applies across conversations (e.g., "User's name is John", "User works in interior design")
- DO store: General preferences that will be useful in future conversations
- DO NOT store: Image-specific requests (e.g., "stage this room in coastal theme" - this is about a specific image, not a long-term preference)
- DO NOT store: Temporary requests (e.g., "make the walls red" - this is a one-time request for a specific image)
- DO NOT store: Short-term context (e.g., "user uploaded an image", "user wants to stage a room" - these are actions, not preferences)
- DO NOT store: Information that only applies to the current conversation or specific images

Consider storing a memory if:
- The user shares a long-term preference or style preference that applies to future work
- The user provides personal information that will be useful across multiple conversations
- The user mentions something that should be remembered for ALL future conversations (not just this one)
- The information represents a general preference, not a one-time request

Consider forgetting a memory if:
- The user explicitly asks to forget something
- A stored memory is incorrect or outdated
- The user contradicts a previous memory
- The memory is no longer relevant

You can perform MULTIPLE actions in one response. For example, you can forget an old memory AND store a new one, or store multiple new memories.

Respond with a JSON object in this exact format:
{
  "stores": ["memory description 1", "memory description 2", ...],
  "forgets": ["memory ID 1", "memory ID 2", ...]
}

If no actions are needed, return: {"stores": [], "forgets": []}
If storing memories, include brief descriptions in the "stores" array.
If forgetting memories, include the memory IDs from the current memories list in the "forgets" array.
If the user wants to forget ALL memories, use "forgets": ["all"] - this will clear all stored memories for the user.

Be very selective. Only store truly important LONG-TERM information that will be useful across multiple conversations.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a memory management system. Always respond with valid JSON only, no other text." },
        { role: "user", content: prompt }
      ],
      temperature: 0.3,
      max_tokens: 700,
      response_format: { type: "json_object" }
    });
    
    const responseText = completion.choices[0].message.content.trim();
    
    if (DEBUG_MODE) {
      console.log('Memory evaluation response:', responseText);
    }
    
    try {
      const result = JSON.parse(responseText);
      const stores = Array.isArray(result.stores) ? result.stores : [];
      const forgets = Array.isArray(result.forgets) ? result.forgets : [];
      
      if (DEBUG_MODE) {
        console.log('Memory actions parsed - Stores:', stores.length, 'Forgets:', forgets.length);
      }
      
      return { stores, forgets };
    } catch (parseError) {
      console.error('Error parsing memory actions JSON:', parseError);
      console.error('Response was:', responseText);
      return { stores: [], forgets: [] };
    }
  } catch (error) {
    console.error('Error evaluating memory actions:', error);
    console.error('Error details:', error.stack);
    return { stores: [], forgets: [] };
  }
}

// Initialize Google AI (for image processing)
let genAI;
try {
  // Try environment variable first (Render), then fall back to local file
  let apiKey = process.env.GOOGLE_AI_API_KEY;
  if (apiKey === undefined){
    console.log('GOOGLE_AI_API_KEY is not set in an enviorment variable, using local file');
    apiKey = fs.readFileSync(path.join(__dirname, 'key.txt'), 'utf8').trim();
  }
  console.log("Google AI API key successfully loaded");
  genAI = new GoogleGenerativeAI(apiKey);
} catch (error) {
  console.error('Error initializing Google AI:', error.message);
}

// Initialize OpenAI GPT (for chat)
let openai;
try {
  // Try environment variable first (Render), then fall back to local file
  let gptApiKey = process.env.GPT_KEY;
  if (gptApiKey === undefined) {
    console.log('GPT_KEY is not set in an environment variable, using local file');
    const gptKeyFile = path.join(__dirname, 'gpt-key.txt');
    if (fs.existsSync(gptKeyFile)) {
      gptApiKey = fs.readFileSync(gptKeyFile, 'utf8').trim();
    }
  }
  if (gptApiKey) {
    openai = new OpenAI({ apiKey: gptApiKey });
    console.log("OpenAI API key successfully loaded");
  } else {
    console.log("Warning: GPT key file is empty, chat features may not work");
  }
} catch (error) {
  console.error('Error initializing OpenAI:', error.message);
  console.log('Chat features will not be available');
}

/**
 * Downscales an image to fit within 1920x1080 while maintaining aspect ratio
 */
async function downscaleImage(imageBuffer) {
  try {
    const image = sharp(imageBuffer);
    const metadata = await image.metadata();
      
    // Check if downscaling is needed
    if (metadata.width <= 1920 && metadata.height <= 1080) {
      return imageBuffer;
    }
    
    // Calculate the scaling factor to fit within 1920x1080 while maintaining aspect ratio
    const scaleWidth = 1920 / metadata.width;
    const scaleHeight = 1080 / metadata.height;
    const scale = Math.min(scaleWidth, scaleHeight);
    
    const newWidth = Math.floor(metadata.width * scale);
    const newHeight = Math.floor(metadata.height * scale);
    
    const processedBuffer = await image
      .resize(newWidth, newHeight, {
        kernel: sharp.kernel.lanczos3,
        withoutEnlargement: true
      })
      .jpeg({ quality: 90 })
      .toBuffer();

    return processedBuffer;
  } catch (error) {
    console.error("Error downscaling image:", error);
    throw error;
  }
}

// Downscale base64 image data URL for GPT API (max 2048x2048, recommended 1024x1024)
// Annotate an image with a short description using GPT
async function annotateImage(imageDataUrl, isCAD = false, detectBlueprint = false) {
  try {
    if (!openai) {
      console.log('[Image Annotation] OpenAI not initialized, skipping annotation');
      return null;
    }
    
    // Downscale image first to save tokens
    const downscaledUrl = await downscaleImageForGPT(imageDataUrl);
    
    // Build prompt based on whether we need to detect blueprint
    let promptText = 'Briefly describe this image in 5-10 words. Then, on a new line, answer: "CAD: True" if this is a blueprint, floor plan, or architectural drawing (top-down 2D plan view), or "CAD: False" if it is a normal room photo or 3D interior view.';
    if (isCAD) {
      // For explicitly CAD images, just get description and mark as CAD: True
      promptText = 'Briefly describe this image in 5-10 words. Then, on a new line, answer: "CAD: True".';
    } else if (!detectBlueprint) {
      // For staged/generated images that are not CAD, just get description and mark as CAD: False
      promptText = 'Briefly describe this image in 5-10 words. Then, on a new line, answer: "CAD: False".';
    }
    
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: promptText },
            { type: 'image_url', image_url: { url: downscaledUrl } }
          ]
        }
      ],
      temperature: 0.3,
      max_tokens: 50
    });
    
    let annotation = completion.choices[0].message.content.trim();
    
    // Extract CAD classification from the response
    const cadMatch = annotation.match(/CAD:\s*(True|False)/i);
    if (cadMatch) {
      // Remove the CAD: True/False line from the annotation text
      annotation = annotation.replace(/\n?\s*CAD:\s*(True|False)\s*\.?$/i, '').trim();
      // Add CAD classification back in standardized format
      const cadValue = cadMatch[1];
      annotation += ` CAD: ${cadValue}`;
    } else {
      // If API didn't return CAD classification, use the provided isCAD value
      annotation += ` CAD: ${isCAD ? 'True' : 'False'}`;
      console.log(`[Image Annotation] Warning: API did not return CAD classification, using default: ${isCAD ? 'True' : 'False'}`);
    }
    
    console.log(`[Image Annotation] Generated annotation: "${annotation}"`);
    return annotation;
  } catch (error) {
    console.error('[Image Annotation] Error annotating image:', error);
    return null;
  }
}

async function downscaleImageForGPT(dataUrl) {
  try {
    // Extract base64 data and MIME type
    const matches = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!matches) {
      console.log('[Image Downscale] Invalid data URL format, returning original');
      return dataUrl;
    }
    
    const mimeType = matches[1];
    const base64Data = matches[2];
    
    // Convert base64 to buffer
    const imageBuffer = Buffer.from(base64Data, 'base64');
    
    // Get image metadata
    const image = sharp(imageBuffer);
    const metadata = await image.metadata();
    
    // OpenAI recommends max 2048x2048, but 1024x1024 is better for performance
    const maxDimension = 1024;
    
    // Check if downscaling is needed
    if (metadata.width <= maxDimension && metadata.height <= maxDimension) {
      console.log(`[Image Downscale] Image ${metadata.width}x${metadata.height} is within limits, no downscaling needed`);
      return dataUrl;
    }
    
    console.log(`[Image Downscale] Downscaling image from ${metadata.width}x${metadata.height} to fit within ${maxDimension}x${maxDimension}`);
    
    // Calculate the scaling factor to fit within maxDimension while maintaining aspect ratio
    const scaleWidth = maxDimension / metadata.width;
    const scaleHeight = maxDimension / metadata.height;
    const scale = Math.min(scaleWidth, scaleHeight);
    
    const newWidth = Math.floor(metadata.width * scale);
    const newHeight = Math.floor(metadata.height * scale);
    
    // Resize and convert to JPEG for smaller size (or keep original format if it's already JPEG)
    let processedBuffer;
    if (mimeType.includes('jpeg') || mimeType.includes('jpg')) {
      processedBuffer = await image
        .resize(newWidth, newHeight, {
          kernel: sharp.kernel.lanczos3,
          withoutEnlargement: true
        })
        .jpeg({ quality: 85 })
        .toBuffer();
    } else {
      // For other formats, convert to JPEG
      processedBuffer = await image
        .resize(newWidth, newHeight, {
          kernel: sharp.kernel.lanczos3,
          withoutEnlargement: true
        })
        .jpeg({ quality: 85 })
        .toBuffer();
    }
    
    // Convert back to base64 data URL
    const newBase64 = processedBuffer.toString('base64');
    const newDataUrl = `data:image/jpeg;base64,${newBase64}`;
    
    const originalSize = Buffer.byteLength(dataUrl, 'utf8');
    const newSize = Buffer.byteLength(newDataUrl, 'utf8');
    const reduction = ((1 - newSize / originalSize) * 100).toFixed(1);
    
    console.log(`[Image Downscale] Downscaled to ${newWidth}x${newHeight}, size reduced by ${reduction}%`);
    
    return newDataUrl;
  } catch (error) {
    console.error('[Image Downscale] Error downscaling image:', error);
    // Return original if downscaling fails
    return dataUrl;
  }
}

/**
 * Generate styling prompt based on user preferences using a matrix system
 */
function generatePrompt(roomType, furnitureStyle, additionalPrompt, removeFurniture) {

  // Add furniture removal instruction if requested
  removeFurniture = removeFurniture === 'true' ? true : false;
  const furnitureRemovalText = removeFurniture 
    ? "First, remove all existing furniture and decor from the room. Then, " 
    : "Try not to remove existing furniture, if there is any. ";
  
  // Build the base prompt
  let basePrompt = `Stage this ${roomType} professionally.`;
  
  // If custom style with additional prompt, use the additional prompt as the main instruction
  if (furnitureStyle === 'custom' && additionalPrompt && additionalPrompt.trim()) {
    basePrompt = additionalPrompt.trim();
  } else {
    // Get the specific prompt for this room type and style combination (fallback)
    basePrompt = promptMatrix[roomType]?.[furnitureStyle] || promptMatrix[roomType]?.['standard'] || basePrompt;
  }
  
  // Build the complete prompt
  let prompt = `${furnitureRemovalText}${basePrompt} Do not alter or remove any walls, windows, doors, or architectural features. Focus only on adding or arranging furniture and decor to professionally stage the room. Leave the rest of the room's architecture the same to highlight the furniture and design. Ensure the result looks realistic and professionally staged with high quality, sharp focus, detailed textures, professional photography lighting, and ultra-realistic rendering. Ensure that no extra doors, windows, or walls are added.`;
  
  // If not custom or if custom but we want to emphasize the additional details
  if (furnitureStyle !== 'custom' && additionalPrompt && additionalPrompt.trim()) {
    prompt += ` Prioritize the following above everything else: ${additionalPrompt.trim()}`;
  }
  
  return prompt;
}

/**
 * Middleman filter to remove unsupported file types from content before sending to OpenAI
 * This ensures AVIF and other unsupported formats never reach GPT
 */
function filterUnsupportedFiles(content, files = []) {
  if (!Array.isArray(content)) {
    return content; // If not an array, return as-is
  }
  
  const supportedImageTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
  const filteredContent = [];
  const unsupportedFiles = [];
  
  for (const item of content) {
    if (item.type === 'image_url' && item.image_url && item.image_url.url) {
      const url = item.image_url.url;
      
      // Check for AVIF in the data URL - only check MIME type, not filename
      const isAVIF = url.includes('data:image/avif') || 
                     url.includes('image/avif;');
      
      // Extract MIME type from data URL (format: data:image/jpeg;base64,...)
      const mimeMatch = url.match(/data:([^;]+)/);
      const mimeType = mimeMatch ? mimeMatch[1].toLowerCase() : '';
      
      // Check if MIME type is unsupported
      const isUnsupported = isAVIF || 
                           (mimeType.startsWith('image/') && !supportedImageTypes.includes(mimeType));
      
      if (isUnsupported) {
        // Find the corresponding file to get its name
        let fileName = 'the file';
        if (files && files.length > 0) {
          // Try to match by base64 data
          const base64Data = url.split(',')[1];
          if (base64Data) {
            const matchingFile = files.find(f => {
              try {
                const fileBase64 = f.buffer.toString('base64');
                return fileBase64.substring(0, 100) === base64Data.substring(0, 100);
              } catch {
                return false;
              }
            });
            if (matchingFile) {
              fileName = matchingFile.originalname;
            }
          }
        }
        
        const fileType = isAVIF ? 'AVIF' : (mimeType.split('/')[1]?.toUpperCase() || 'unsupported format');
        unsupportedFiles.push({ name: fileName, type: fileType });
        
        // Convert to text instead of image
        filteredContent.push({
          type: 'text',
          text: `I uploaded "${fileName}" but it is in ${fileType} format which is not supported.`
        });
      } else {
        // Supported image - keep it
        filteredContent.push(item);
      }
    } else {
      // Not an image - keep as-is
      filteredContent.push(item);
    }
  }
  
  return { filteredContent, unsupportedFiles };
}

/**
 * Filters unsupported files from conversation history messages
 */
// Deduplicate messages based on role and content
function deduplicateMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  
  const seen = new Set();
  const deduplicated = [];
  
  for (const msg of messages) {
    // Skip invalid messages
    if (!msg || !msg.role) {
      continue;
    }
    
    // Create a unique key based on role and content
    let key;
    if (Array.isArray(msg.content)) {
      // For array content, stringify the structure (without base64 data for images)
      const simplifiedContent = msg.content.map(item => {
        if (item.type === 'image_url' && item.image_url && item.image_url.url) {
          // For images, use a placeholder to avoid comparing base64 data
          return { type: 'image_url', image_url: { url: '[IMAGE_DATA]' } };
        } else if (item.type === 'text') {
          // Normalize text content (trim whitespace)
          return { type: 'text', text: (item.text || '').trim() };
        }
        return item;
      });
      // Sort array items to ensure consistent ordering
      simplifiedContent.sort((a, b) => {
        if (a.type !== b.type) return a.type.localeCompare(b.type);
        if (a.type === 'text' && b.type === 'text') {
          return (a.text || '').localeCompare(b.text || '');
        }
        return 0;
      });
      key = `${msg.role}:${JSON.stringify(simplifiedContent)}`;
    } else if (typeof msg.content === 'string') {
      // Normalize text content (trim whitespace) for consistent comparison
      key = `${msg.role}:${msg.content.trim()}`;
    } else {
      // Fallback for other content types
      key = `${msg.role}:${JSON.stringify(msg.content)}`;
    }
    
    // Only add if we haven't seen this exact message before
    if (!seen.has(key)) {
      seen.add(key);
      deduplicated.push(msg);
    } else {
      // Log when we skip a duplicate
      if (DEBUG_MODE) {
        const contentPreview = Array.isArray(msg.content) 
          ? `[${msg.content.length} items]` 
          : (typeof msg.content === 'string' ? msg.content.substring(0, 50) : 'non-string');
        console.log(`[Deduplication] Skipping duplicate ${msg.role} message: ${contentPreview}...`);
      }
    }
  }
  
  return deduplicated;
}

function filterConversationHistory(messages) {
  if (!Array.isArray(messages)) {
    return messages;
  }
  
  return messages.map(msg => {
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      const { filteredContent } = filterUnsupportedFiles(msg.content);
      return {
        ...msg,
        content: filteredContent
      };
    }
    return msg;
  });
}

/**
 * Strips images from conversation history messages (except current message)
 * This prevents payload size issues while keeping text context
 */
function stripImagesFromHistory(messages, keepCurrentMessageImages = false) {
  if (!Array.isArray(messages)) {
    return messages;
  }
  
  return messages.map((msg, index) => {
    const isLastMessage = index === messages.length - 1;
    const shouldKeepImages = keepCurrentMessageImages && isLastMessage && msg.role === 'user';
    
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      if (shouldKeepImages) {
        // Keep images in current message
        return msg;
      } else {
        // Replace images with filename references, keep text
        const textParts = [];
        let imageCount = 0;
        
        msg.content.forEach(item => {
          if (item.type === 'text') {
            textParts.push(item.text);
          } else if (item.type === 'image_url') {
            imageCount++;
            // Try to extract filename from metadata or use generic name
            const filename = item.filename || item.originalname || (imageCount === 1 ? 'uploaded_image.jpg' : `image_${imageCount}.jpg`);
            const isStaged = item.isStaged || false;
            if (isStaged) {
              textParts.push(`[Staged image from previous message]`);
            } else {
              textParts.push(`[Image: ${filename}]`);
            }
          }
        });
        
        const textContent = textParts.join('\n\n');
        return {
          role: 'user',
          content: textContent || '[Previous message]'
        };
      }
    } else if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      // Replace images with references, keep text
      const textParts = [];
      let imageCount = 0;
      
      msg.content.forEach(item => {
        if (item.type === 'text') {
          textParts.push(item.text);
        } else if (item.type === 'image_url') {
          imageCount++;
          textParts.push(`[Staged image from previous message]`);
        }
      });
      
      const textContent = textParts.join('\n\n');
      return {
        role: 'assistant',
        content: textContent || '[Previous response]'
      };
    }
    return msg;
  });
}

/**
 * Extracts image from conversation history by index (0 = most recent, 1 = second most recent, etc.)
 * Returns the image data URL or null if not found
 */
function getImageFromHistory(messages, imageIndex = 0) {
  if (!Array.isArray(messages)) {
    console.log(`[getImageFromHistory] Messages is not an array:`, typeof messages);
    return null;
  }
  
  const imageMessages = [];
  
  // Collect ALL images from all messages (both user and assistant)
  // Process in reverse chronological order (most recent first)
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      // Get ALL images from this message, not just the first one
      const imageItems = msg.content.filter(item => item.type === 'image_url' && item.image_url && item.image_url.url);
      // Process images in order (first image in message = most recent in that message)
      for (let j = imageItems.length - 1; j >= 0; j--) {
        const imageItem = imageItems[j];
        imageMessages.push({
          url: imageItem.image_url.url,
          isStaged: false,
          isGenerated: false,
          messageIndex: i,
          filename: imageItem.filename || imageItem.originalname || null,
          annotation: imageItem._annotation || imageItem.annotation || null
        });
        console.log(`[getImageFromHistory] Found user-uploaded image at message index ${i}, image ${j + 1}/${imageItems.length}, filename: ${imageItem.filename || imageItem.originalname || 'unknown'}, total images found: ${imageMessages.length}`);
      }
    } else if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      // Get ALL staged and generated images from this message
      const imageItems = msg.content.filter(item => 
        item.type === 'image_url' && 
        item.image_url && 
        item.image_url.url && 
        (item.isStaged || item.isGenerated)
      );
      // Process images in order
      for (let j = imageItems.length - 1; j >= 0; j--) {
        const imageItem = imageItems[j];
        imageMessages.push({
          url: imageItem.image_url.url,
          isStaged: imageItem.isStaged || false,
          isGenerated: imageItem.isGenerated || false,
          messageIndex: i,
          filename: imageItem.filename || imageItem.originalname || null,
          annotation: imageItem._annotation || imageItem.annotation || null
        });
        const imageType = imageItem.isStaged ? 'staged' : 'generated';
        console.log(`[getImageFromHistory] Found ${imageType} image at message index ${i}, image ${j + 1}/${imageItems.length}, total images found: ${imageMessages.length}`);
      }
    }
  }
  
  console.log(`[getImageFromHistory] Total images found: ${imageMessages.length}, requested index: ${imageIndex}`);
  
  // Return the image at the requested index (0 = most recent)
  if (imageIndex >= 0 && imageIndex < imageMessages.length) {
    return imageMessages[imageIndex];
  }
  
  // If requested index doesn't exist but we have images, return the most recent (index 0) as fallback
  if (imageMessages.length > 0) {
    console.log(`[getImageFromHistory] Requested index ${imageIndex} not found, returning most recent image (index 0) as fallback`);
    return imageMessages[0];
  }
  
  return null;
}

/**
 * Builds image context with annotations for GPT system instructions
 * Returns an object with imageContext string and imagesSentToGPT array
 */
function buildImageContext(messages) {
  const imageMessages = [];
  const imagesSentToGPT = []; // Separate list of images that were sent to GPT (for assistant messages)
  
  if (!Array.isArray(messages)) {
    return { imageContext: '', imagesSentToGPT: [], originalImageIndex: null };
  }
  
  // Collect ALL images in reverse chronological order (most recent first)
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      // Get ALL images from this message
      const imageItems = msg.content.filter(item => item.type === 'image_url' && item.image_url && item.image_url.url);
      // Process images in reverse order within the message
      for (let j = imageItems.length - 1; j >= 0; j--) {
        const imageItem = imageItems[j];
        const filename = imageItem.filename || imageItem.originalname || null;
        const annotation = imageItem._annotation || imageItem.annotation || null;
        imageMessages.push({ 
          index: imageMessages.length, 
          type: 'user-uploaded', 
          messageIndex: i,
          filename: filename,
          annotation: annotation
        });
        // User-uploaded images are sent to GPT
        imagesSentToGPT.push({
          index: imagesSentToGPT.length,
          type: 'user-uploaded',
          filename: filename,
          annotation: annotation
        });
      }
    } else if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      // Get ALL staged and generated images from this message
      const imageItems = msg.content.filter(item => 
        item.type === 'image_url' && 
        item.image_url && 
        item.image_url.url && 
        (item.isStaged || item.isGenerated)
      );
      // Process images in reverse order within the message
      for (let j = imageItems.length - 1; j >= 0; j--) {
        const imageItem = imageItems[j];
        const filename = imageItem.filename || imageItem.originalname || null;
        const imageType = imageItem.isStaged ? 'staged' : 'generated';
        const annotation = imageItem._annotation || imageItem.annotation || null;
        imageMessages.push({ 
          index: imageMessages.length, 
          type: imageType, 
          messageIndex: i,
          filename: filename,
          annotation: annotation
        });
        // AI-generated images are also sent to GPT in future messages
        imagesSentToGPT.push({
          index: imagesSentToGPT.length,
          type: imageType,
          filename: filename,
          annotation: annotation
        });
      }
    }
  }
  
  // Find the original (first) user-uploaded image
  const userUploadedImages = imageMessages.filter(img => img.type === 'user-uploaded');
  let originalImageIndex = null;
  if (userUploadedImages.length > 0) {
    originalImageIndex = userUploadedImages[userUploadedImages.length - 1].index;
  }
  
  // Build image context string
  let imageContext = '';
  if (imageMessages.length > 0) {
    imageContext = '\n\nAvailable images in conversation history (index 0 = most recent, higher index = older):\n';
    imageMessages.forEach((img, idx) => {
      let description = `${img.type} image`;
      if (img.filename) {
        description += ` (filename: ${img.filename})`;
      }
      if (img.annotation) {
        // Parse CAD classification from annotation
        const cadMatch = img.annotation.match(/CAD:\s*(True|False)/i);
        const isCAD = cadMatch ? cadMatch[1].toLowerCase() === 'true' : false;
        // Remove CAD classification from description for cleaner display, but show it separately
        const annotationWithoutCAD = img.annotation.replace(/\s*CAD:\s*(True|False)/i, '').trim();
        description += ` - ${annotationWithoutCAD}`;
        description += ` [CAD: ${isCAD ? 'True' : 'False'}]`;
      } else {
        // If no annotation, default to False for CAD
        description += ` [CAD: False]`;
      }
      if (idx === originalImageIndex) {
        description += ' [ORIGINAL/FIRST USER-UPLOADED IMAGE]';
      }
      imageContext += `- Index ${idx}: ${description}\n`;
    });
    if (originalImageIndex !== null) {
      imageContext += `\nIMPORTANT: The "original image" or "first image" is at index ${originalImageIndex}. When the user says "original image", "first image", "initial image", "go back to the original", or "refer back to the original image", use index ${originalImageIndex} in the staging request.`;
    }
    imageContext += `\nIMPORTANT: When multiple images are uploaded in the same message, they are indexed separately. Use the filename and annotation to identify which image the user is referring to (e.g., if user says "add this chair", look for an image with "chair" in the filename or annotation).`;
    imageContext += `\nIMPORTANT: All images in the list above (user-uploaded, staged, generated, and CAD-staging renders) can be recalled using the recall function. Generated and staged images you created are included in this list and can be recalled by their index.`;
    
    // Add separate list of images sent to GPT
    if (imagesSentToGPT.length > 0) {
      imageContext += `\n\nImages sent to GPT in previous messages (for reference when building responses):\n`;
      imagesSentToGPT.forEach((img, idx) => {
        // Parse CAD classification from annotation
        let cadStatus = 'False';
        let annotationText = img.annotation || '';
        if (img.annotation) {
          const cadMatch = img.annotation.match(/CAD:\s*(True|False)/i);
          cadStatus = cadMatch ? cadMatch[1] : 'False';
          // Remove CAD classification from annotation text for cleaner display
          annotationText = img.annotation.replace(/\s*CAD:\s*(True|False)/i, '').trim();
        }
        let description = `${img.type} image`;
        if (img.filename) {
          description += ` (filename: ${img.filename})`;
        }
        if (annotationText) {
          description += ` - ${annotationText}`;
        }
        description += ` [CAD: ${cadStatus}]`;
        imageContext += `- GPT Image ${idx}: ${description}\n`;
      });
    }
  }
  
  return { imageContext, imagesSentToGPT, originalImageIndex };
}

/**
 * Gets the index of the original (first) user-uploaded image in the conversation history
 * Returns null if no original image is found
 */
function getOriginalImageIndex(messages) {
  if (!Array.isArray(messages)) {
    return null;
  }
  
  const userUploadedImages = [];
  
  // Collect all user-uploaded images in reverse chronological order (most recent first)
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      const imageItem = msg.content.find(item => item.type === 'image_url');
      if (imageItem && imageItem.image_url && imageItem.image_url.url) {
        userUploadedImages.push({
          index: userUploadedImages.length,
          messageIndex: i
        });
      }
    }
  }
  
  // The original image is at the highest index (oldest)
  if (userUploadedImages.length > 0) {
    return userUploadedImages[userUploadedImages.length - 1].index;
  }
  
  return null;
}

/**
 * Evaluates if staging should be performed and if an old image should be used
 * Similar to evaluateMemoryActions, but for staging requests
 */
async function evaluateStagingRequest(userMessage, aiResponse, hasCurrentImage, conversationHistory, model = 'gpt-4o-mini') {
  try {
    if (!openai) {
      console.error('OpenAI not initialized, cannot evaluate staging request');
      return null;
    }
    
    // Build context about available images in history
    let imageContext = '';
    let originalImageIndex = null;
    if (conversationHistory && Array.isArray(conversationHistory)) {
      const imageMessages = [];
      // Collect ALL images in reverse chronological order (most recent first)
      for (let i = conversationHistory.length - 1; i >= 0; i--) {
        const msg = conversationHistory[i];
        if (msg.role === 'user' && Array.isArray(msg.content)) {
          // Get ALL images from this message, not just the first one
          const imageItems = msg.content.filter(item => item.type === 'image_url');
          // Process images in reverse order within the message (so first image in message = most recent)
          for (let j = imageItems.length - 1; j >= 0; j--) {
            const imageItem = imageItems[j];
            const filename = imageItem.filename || imageItem.originalname || null;
            imageMessages.push({ 
              index: imageMessages.length, 
              type: 'user-uploaded', 
              messageIndex: i,
              filename: filename
            });
          }
        } else if (msg.role === 'assistant' && Array.isArray(msg.content)) {
          // Get ALL staged and generated images from this message
          const imageItems = msg.content.filter(item => 
            item.type === 'image_url' && 
            (item.isStaged || item.isGenerated)
          );
          // Process images in reverse order within the message
          for (let j = imageItems.length - 1; j >= 0; j--) {
            const imageItem = imageItems[j];
            const filename = imageItem.filename || imageItem.originalname || null;
            const imageType = imageItem.isStaged ? 'staged' : 'generated';
            imageMessages.push({ 
              index: imageMessages.length, 
              type: imageType, 
              messageIndex: i,
              filename: filename
            });
          }
        }
      }
      
      // Find the original (first) user-uploaded image (it's at the highest index since we're going reverse chronological)
      const userUploadedImages = imageMessages.filter(img => img.type === 'user-uploaded');
      if (userUploadedImages.length > 0) {
        // The last one in the array (highest index) is the original/first uploaded image
        originalImageIndex = userUploadedImages[userUploadedImages.length - 1].index;
      }
      
      if (imageMessages.length > 0) {
        imageContext = `\n\nAvailable images in conversation history (index 0 = most recent, higher index = older):\n`;
        imageMessages.forEach((img, idx) => {
          let description = `${img.type} image (from message ${img.messageIndex})`;
          if (img.filename) {
            description += ` (filename: ${img.filename})`;
          }
          if (idx === originalImageIndex) {
            description += ' [ORIGINAL/FIRST USER-UPLOADED IMAGE]';
          }
          imageContext += `- Index ${idx}: ${description}\n`;
        });
        if (originalImageIndex !== null) {
          imageContext += `\nIMPORTANT: The "original image" or "first image" is at index ${originalImageIndex}. When the user says "original image", "first image", "initial image", "go back to the original", or "refer back to the original image", use index ${originalImageIndex}.`;
        }
        imageContext += `\nIMPORTANT: When multiple images are uploaded in the same message, they are indexed separately. Use the filename to identify which image the user is referring to (e.g., if user says "add this chair" or mentions a specific filename, look for an image with that filename or matching description).`;
      }
    }
    
    const prompt = `You are a staging request evaluator for Stagify.ai. Analyze the following conversation and determine if room staging should be performed.

User message: "${userMessage}"
AI response: "${aiResponse}"
Current message has image: ${hasCurrentImage}${imageContext}

CRITICAL: Staging should be performed if the user wants to:
- Add furniture, decorate, or style a room
- Modify ANY aspect of an image (change colors, walls, furniture, etc.)
- Apply any visual changes to a room image
- "Show me X but with Y" (e.g., "show me the original but with red walls") = STAGING REQUEST
- "Make X red/blue/etc" (e.g., "make the walls red") = STAGING REQUEST
- "Change X to Y" (e.g., "change the color to blue") = STAGING REQUEST
- Even if the user says "I don't want it staged" but then asks to modify the image, it's still a staging request

If the user wants to stage a room or modify an image, respond with a JSON object containing staging parameters:
{
  "shouldStage": true,
  "roomType": "Living room" | "Bedroom" | "Kitchen" | "Bathroom" | "Dining room" | "Office" | "Other",
  "additionalPrompt": "Create a detailed, comprehensive staging prompt based on the user's request. Include specific details about: furniture style, color scheme, mood/atmosphere, specific furniture pieces to add, decor elements, lighting preferences, and any other relevant details. Make it detailed and descriptive, as if you're instructing a professional interior designer. Base this on what the user asked for in their message.",
  "removeFurniture": true/false,
  "usePreviousImage": false | 0 | 1 | 2 | ...
}

IMPORTANT: 
- Always set furnitureStyle to "custom" (this will be handled automatically)
- The additionalPrompt should be a comprehensive, detailed description that captures the user's vision
- If the user says something vague like "make it cozy" or "modern style", expand it into a detailed prompt describing what that means
- If the user mentions specific items, colors, or styles, incorporate those into the detailed prompt
- "usePreviousImage": Set to false if using the current message's image, or set to the index (0 = most recent image in history, 1 = second most recent, etc.) if the user wants to modify a previous image. 
  * If the user says "modify the previous staging" or "change the last one", use index 0 (most recent).
  * If the user says "original image", "first image", "initial image", "go back to the original", "the original", or "show me the original", they mean the FIRST user-uploaded image, which is at the HIGHEST index number (oldest image). Look at the image context above to find which index corresponds to the first user-uploaded image.
  * If the user says "the image before that" or "the one before the last one", use index 1 (second most recent).
  * If the user says "show me the original but with X" or "the original but with X", use the original image index.

If staging is NOT needed (user is just asking questions, not requesting image modifications), respond with:
{
  "shouldStage": false
}

Extract the parameters from the user's message and the AI's response.`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a helpful assistant that evaluates staging requests. Always respond with valid JSON only.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' }
    });
    
    const result = JSON.parse(completion.choices[0].message.content);
    
    if (result.shouldStage) {
      return {
        roomType: result.roomType || 'Living room',
        furnitureStyle: 'custom', // Always use custom
        additionalPrompt: result.additionalPrompt || '',
        removeFurniture: result.removeFurniture || false,
        usePreviousImage: result.usePreviousImage !== undefined ? result.usePreviousImage : false
      };
    }
    
    return null;
  } catch (error) {
    console.error('Error evaluating staging request:', error);
    return null;
  }
}

/**
 * Process image through Stagify staging pipeline
 */
/**
 * Generate an image from a text prompt using Gemini
 * This is separate from the staging system - pure text-to-image generation
 */
async function processImageGeneration(prompt, req, geminiModel = 'gemini-2.5-flash-image-preview') {
  try {
    if (!genAI) {
      throw new Error('Gemini AI service not properly configured');
    }
    
    console.log(`[Image Generation] Generating image with prompt: "${prompt}"`);
    console.log(`[Image Generation] Using Gemini model: ${geminiModel}`);
    
    // Use Gemini's image generation model (text-to-image, no input image needed)
    const model = genAI.getGenerativeModel({ model: geminiModel });
    
    // For text-to-image generation, we only send the text prompt
    const generatePrompt = [
      { text: prompt }
    ];
    
    const result = await model.generateContent(generatePrompt);
    const response = await result.response;
    
    if (!response || !response.candidates || response.candidates.length === 0) {
      throw new Error('Image generation failed - no results generated');
    }
    
    // Extract the generated image
    for (const part of response.candidates[0].content.parts) {
      if (part.inlineData) {
        const imageData = part.inlineData.data;
        const generatedImage = `data:image/png;base64,${imageData}`;
        console.log(`[Image Generation] Successfully generated image`);
        return generatedImage;
      }
    }
    
    throw new Error('No image data in AI response');
  } catch (error) {
    console.error('Error generating image:', error);
    throw error;
  }
}

async function processStaging(imageBuffer, stagingParams, req, furnitureImageBuffer = null, geminiModel = 'gemini-2.5-flash-image-preview') {
  try {
    if (!genAI) {
      throw new Error('AI service not properly configured');
    }
    
    const processedImageBuffer = await downscaleImage(imageBuffer);
    const base64Image = processedImageBuffer.toString("base64");
    
    const prompt = [
      { text: generatePrompt(
        stagingParams.roomType,
        stagingParams.furnitureStyle,
        stagingParams.additionalPrompt,
        stagingParams.removeFurniture
      ) },
      {
        inlineData: {
          mimeType: "image/jpeg",
          data: base64Image,
        },
      },
    ];
    
    // If furniture image is provided, add it to the prompt
    if (furnitureImageBuffer) {
      const processedFurnitureBuffer = await downscaleImage(furnitureImageBuffer);
      const base64Furniture = processedFurnitureBuffer.toString("base64");
      prompt.push({
        inlineData: {
          mimeType: "image/jpeg",
          data: base64Furniture,
        },
      });
      // Update the prompt text to include furniture reference
      prompt[0].text += '\n\nIMPORTANT: The second image provided is a specific piece of furniture that the user wants to add to the room. Please incorporate this exact furniture piece into the staged room design, matching its style, color, and appearance as closely as possible.';
      console.log(`[Staging] Including furniture image in staging request`);
    }
    
    // Log prompt to file
    logPromptToFile(
      prompt[0].text,
      stagingParams.roomType,
      stagingParams.furnitureStyle,
      stagingParams.additionalPrompt,
      stagingParams.removeFurniture,
      'unknown',
      'unknown',
      'unknown',
      req
    );
    
    console.log(`[Staging] Using Gemini model: ${geminiModel}`);
    const model = genAI.getGenerativeModel({ model: geminiModel });
    const result = await model.generateContent(prompt);
    const response = await result.response;
    
    if (!response || !response.candidates || response.candidates.length === 0) {
      throw new Error('AI processing failed - no results generated');
    }
    
    // Extract the generated image
    for (const part of response.candidates[0].content.parts) {
      if (part.inlineData) {
        const imageData = part.inlineData.data;
        return `data:image/png;base64,${imageData}`;
      }
    }
    
    throw new Error('No image data in AI response');
  } catch (error) {
    console.error('Error processing staging:', error);
    throw error;
  }
}

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handling middleware for multer
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ 
        error: 'File too large', 
        message: 'Please upload an image smaller than 100MB',
        code: 'FILE_TOO_LARGE'
      });
    }
    return res.status(400).json({ 
      error: 'Upload error', 
      message: err.message,
      code: err.code 
    });
  }
  next(err);
});

// Image processing endpoint
app.post('/api/process-image', upload.single('image'), async (req, res) => {
  
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided' });
    }

    if (!genAI) {
      return res.status(500).json({ error: 'AI service not properly configured' });
    }

    const { roomType = 'Living room', furnitureStyle = 'standard', additionalPrompt = '', removeFurniture = false, userRole = 'unknown', userReferralSource = 'unknown', userEmail = 'unknown', model: gptModel } = req.body;
    
    // Get model from request or default to gpt-4o-mini
    const selectedModel = gptModel || 'gpt-4o-mini';
    const geminiModel = getGeminiImageModel(selectedModel);
    
    const processedImageBuffer = await downscaleImage(req.file.buffer);
    const base64Image = processedImageBuffer.toString("base64");

    // Generate prompt based on user preferences
    const promptText = generatePrompt(roomType, furnitureStyle, additionalPrompt, removeFurniture);
    
    // Log prompt to file instead of console
    logPromptToFile(promptText, roomType, furnitureStyle, additionalPrompt, removeFurniture, userRole, userReferralSource, userEmail, req);
    
    // Increment prompt count
    promptCount++;

    const prompt = [
      { text: promptText },
      {
        inlineData: {
          mimeType: "image/jpeg",
          data: base64Image, 
        },
      },
    ];

    console.log(`[Image Processing] Using Gemini model: ${geminiModel}`);
    const geminiModelInstance = genAI.getGenerativeModel({ model: geminiModel });
    const result = await geminiModelInstance.generateContent(prompt);
    const response = await result.response;

    if (!response || !response.candidates || response.candidates.length === 0) {
      console.error("No candidates in response");
      return res.status(500).json({ error: 'AI processing failed - no results generated' });
    }
    
    // Extract the generated image
    for (const part of response.candidates[0].content.parts) {
      if (part.inlineData) {
        const imageData = part.inlineData.data;

        // Return the base64 image data
        return res.json({
          success: true,
          image: `data:image/png;base64,${imageData}`,
          promptUsed: promptText
        });
      }
    }
    
    return res.status(500).json({ error: 'No image data in AI response' });
    
  } catch (error) {
    console.error("Error processing image:", error);
    return res.status(500).json({ 
      error: 'Image processing failed', 
      details: error.message 
    });
  }
});

// Contact logging endpoint
app.post('/api/log-contact', (req, res) => {
  try {
    const { userRole = 'unknown', referralSource = 'unknown', email = 'unknown', userAgent = 'unknown' } = req.body;
    const timestamp = new Date().toISOString();
    const ipAddress = req.ip || req.connection.remoteAddress || 'unknown';
    
    // Create CSV row
    const csvRow = `${timestamp},"${userRole}","${referralSource}","${email}","${userAgent}","${ipAddress}"\n`;
    
    // Use mounted disk on Render, project data folder locally
    let logDir;
    
    if (process.env.RENDER && fs.existsSync('/data')) {
      // Use Render's mounted disk
      logDir = '/data';
      console.log('Using Render persistent disk for contact logs');
    } else {
      // Use project data folder for local development
      logDir = path.join(__dirname, 'data');
      
      // Create data directory if it doesn't exist
      if (!fs.existsSync(logDir)) {
        try {
          fs.mkdirSync(logDir, { recursive: true });
          console.log('Created local data directory successfully');
        } catch (error) {
          console.log('Error: Cannot create data directory, using project root');
          logDir = __dirname;
        }
      }
    }

    const logFile = path.join(logDir, 'contact_logs.csv');
    
    // Check if file exists to add header if it's a new file
    const fileExists = fs.existsSync(logFile);
    
    if (!fileExists) {
      // Create new file with header and first row
      const header = 'timestamp,userRole,referralSource,email,userAgent,ipAddress\n';
      fs.writeFileSync(logFile, header + csvRow);
    } else {
      // Append to existing file
      fs.appendFile(logFile, csvRow, (err) => {
        if (err) {
          console.error('Error writing to contact log:', err);
        }
      });
    }
    
    // Increment contact count
    contactCount++;
    
    res.json({ success: true, message: 'Contact logged successfully' });
  } catch (error) {
    console.error('Error in contact logging:', error);
    res.status(500).json({ success: false, message: 'Failed to log contact' });
  }
});

// Function to log chat messages to CSV file (only user messages, not AI responses)
function logChatToFile(userId, userMessage, aiResponse, files, ipAddress, userAgent) {
  try {
    let logDir;
    
    if (process.env.RENDER && fs.existsSync('/data')) {
      // Use Render's mounted disk
      logDir = '/data';
    } else {
      // Use project data folder for local development
      logDir = path.join(__dirname, 'data');
      
      if (!fs.existsSync(logDir)) {
        try {
          fs.mkdirSync(logDir, { recursive: true });
          console.log('Created local data directory successfully');
        } catch (error) {
          console.log('Error: Cannot create data directory, using project root');
          logDir = __dirname;
        }
      }
    }

    const logFile = path.join(logDir, 'chat_logs.csv');
    
    const timestamp = new Date().toISOString();
    const fileNames = files && files.length > 0 ? files.map(f => f.name || f.originalname || 'unknown').join('; ') : '';
    const fileTypes = files && files.length > 0 ? files.map(f => f.type || f.mimetype || 'unknown').join('; ') : '';
    
    // Escape commas and quotes in CSV
    const escapeCSV = (str) => {
      if (!str) return '';
      return '"' + String(str).replace(/"/g, '""') + '"';
    };
    
    // Only log user message, not AI response
    const csvRow = `${timestamp},${escapeCSV(userId)},${escapeCSV(userMessage)},${escapeCSV('')},${escapeCSV(fileNames)},${escapeCSV(fileTypes)},${escapeCSV(ipAddress)},${escapeCSV(userAgent)}\n`;
    
    // Check if file exists to add header if it's a new file
    const fileExists = fs.existsSync(logFile);
    
    if (!fileExists) {
      // Create new file with header and first row
      const header = 'timestamp,userId,userMessage,aiResponse,fileNames,fileTypes,ipAddress,userAgent\n';
      fs.writeFileSync(logFile, header + csvRow);
    } else {
      // Append to existing file
      fs.appendFile(logFile, csvRow, (err) => {
        if (err) {
          console.error('Error writing to chat log:', err);
        }
      });
    }
  } catch (error) {
    console.error('Error in logChatToFile:', error);
  }
}

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    aiConfigured: !!genAI
  });
});

// Prompt count endpoint
app.get('/api/prompt-count', (req, res) => {
  res.json({ 
    promptCount: promptCount
  });
});

// Contact count endpoint
app.get('/api/contact-count', (req, res) => {
  res.json({ 
    contactCount: contactCount
  });
});

// PDF Processing Proxy Endpoints
// Health check proxy
app.get('/api/pdf-health', async (req, res) => {
  try {
    const response = await fetch(`${PDF_PROCESSING_SERVER}/health`);
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Error checking PDF server health:', error);
    res.status(500).json({ 
      status: 'error', 
      message: 'Failed to check PDF server health',
      error: error.message 
    });
  }
});

// PDF processing proxy endpoint
app.post('/api/process-pdf', pdfUpload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No PDF file provided' });
    }

    // Get query parameters from request
    const skip = req.query.skip || '4';
    const concurrency = req.query.concurrency || '2';
    const dpi = req.query.dpi || '110';
    const continueOnError = req.query.continue || 'false';
    const merge = req.query.merge || 'false';
    const filename = req.query.filename || req.file.originalname;

    // Build query parameters for external server
    const params = new URLSearchParams();
    params.append('skip', skip);
    params.append('concurrency', concurrency);
    params.append('dpi', dpi);
    if (continueOnError !== 'false') params.append('continue', continueOnError);
    if (merge !== 'false') params.append('merge', merge);
    if (filename) params.append('filename', filename);

    const urlPath = `/process?${params.toString()}`;
    const targetUrl = new URL(PDF_PROCESSING_SERVER);

    // Create FormData for the external server using form-data package
    const formData = new FormData();
    formData.append('pdf', req.file.buffer, {
      filename: req.file.originalname,
      contentType: 'application/pdf'
    });

    // Forward the request to the external server using https module
    console.log(`Forwarding PDF processing request to ${PDF_PROCESSING_SERVER}${urlPath}`);
    
    return new Promise((resolve, reject) => {
      const options = {
        hostname: targetUrl.hostname,
        port: targetUrl.port || 443,
        path: urlPath,
        method: 'POST',
        headers: formData.getHeaders()
      };

      const proxyReq = https.request(options, (proxyRes) => {
        // Handle errors from proxy response
        if (proxyRes.statusCode && proxyRes.statusCode >= 400) {
          let errorData = '';
          proxyRes.on('data', (chunk) => {
            errorData += chunk.toString();
          });
          proxyRes.on('end', () => {
            try {
              const parsedError = JSON.parse(errorData);
              res.status(proxyRes.statusCode).json({
                error: parsedError.message || parsedError.error || `Server error: ${proxyRes.statusCode}`,
                ...parsedError
              });
            } catch {
              res.status(proxyRes.statusCode).json({ 
                error: errorData || `Server error: ${proxyRes.statusCode}` 
              });
            }
            resolve();
          });
          return;
        }

        // Set status code for successful response
        res.status(proxyRes.statusCode || 200);

        // Copy headers from proxy response (skip problematic ones)
        Object.keys(proxyRes.headers).forEach(key => {
          const lowerKey = key.toLowerCase();
          // Skip headers that shouldn't be forwarded or will be set manually
          if (lowerKey !== 'content-encoding' && 
              lowerKey !== 'transfer-encoding' &&
              lowerKey !== 'connection' &&
              lowerKey !== 'content-length') {
            try {
              res.setHeader(key, proxyRes.headers[key]);
            } catch (err) {
              // Ignore header setting errors
              console.warn(`Could not set header ${key}:`, err.message);
            }
          }
        });

        // Ensure Content-Type is set for PDF
        if (!res.getHeader('content-type')) {
          res.setHeader('Content-Type', 'application/pdf');
        }

        // Set Content-Disposition for download
        if (filename) {
          res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        }

        // Handle proxy response errors
        proxyRes.on('error', (err) => {
          console.error('Proxy response error:', err);
          if (!res.headersSent) {
            res.status(500).json({ 
              error: 'Error receiving response from PDF server', 
              details: err.message 
            });
          }
          resolve();
        });

        // Stream the response from proxy to client
        proxyRes.pipe(res);
        
        proxyRes.on('end', () => {
          resolve();
        });
      });

      proxyReq.on('error', (error) => {
        console.error('Proxy request error:', error);
        if (!res.headersSent) {
          res.status(500).json({ 
            error: 'PDF processing failed', 
            details: error.message 
          });
        }
        reject(error);
      });

      // Pipe form data to the proxy request
      formData.pipe(proxyReq);
      
      formData.on('error', (error) => {
        console.error('FormData error:', error);
        proxyReq.destroy();
        if (!res.headersSent) {
          res.status(500).json({ 
            error: 'PDF processing failed', 
            details: error.message 
          });
        }
        reject(error);
      });
    });

  } catch (error) {
    console.error('Error processing PDF:', error);
    if (!res.headersSent) {
      return res.status(500).json({ 
        error: 'PDF processing failed', 
        details: error.message 
      });
    }
  }
});

// Load endpoint access key from file, fall back to environment variable
let LOGS_ACCESS_KEY;
try {
  LOGS_ACCESS_KEY = fs.readFileSync(path.join(__dirname, 'endpointkey.txt'), 'utf8').trim();
  console.log('Endpoint access key successfully loaded from file');
} catch (error) {
  console.log('Endpoint key file not found, trying environment variable');
  LOGS_ACCESS_KEY = process.env.endpoint_key;
  if (LOGS_ACCESS_KEY) {
    console.log('Endpoint access key successfully loaded from environment variable');
  } else {
    console.error('Error: No endpoint access key found in file or environment variable');
  }
}

// Middleware to protect logs endpoints with password
function protectLogs(req, res, next) {
  if (!LOGS_ACCESS_KEY) {
    return res.status(500).json({ 
      error: 'Server configuration error',
      message: 'Logs access key not configured'
    });
  }
  
  const accessKey = req.query.key;
  
  if (accessKey === LOGS_ACCESS_KEY) {
    next();
  } else {
    res.status(403).json({ 
      error: 'Access denied',
      message: 'Valid access key required. Use ?key=YOUR_KEY in the URL'
    });
  }
}

// Prompt logs endpoint - serves the prompt logs CSV file (protected)
app.get('/promptlogs', protectLogs, (req, res) => {
  try {
    let logDir;
    
    if (process.env.RENDER && fs.existsSync('/data')) {
      // Use Render's mounted disk
      logDir = '/data';
    } else {
      // Use project data folder for local development
      logDir = path.join(__dirname, 'data');
    }

    const logFile = path.join(logDir, 'prompt_logs.csv');
    
    if (fs.existsSync(logFile)) {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'inline; filename="prompt_logs.csv"');
      res.sendFile(logFile);
    } else {
      res.status(404).json({ 
        error: 'Log file not found',
        message: 'No prompt logs are available yet'
      });
    }
  } catch (error) {
    console.error('Error serving prompt log file:', error);
    res.status(500).json({ 
      error: 'Failed to retrieve prompt logs',
      message: error.message
    });
  }
});

// Welcome message endpoint - returns personalized or generic welcome message
app.get('/api/welcome-message', async (req, res) => {
  try {
    // Get user identifier from query or generate from IP
    const userId = req.query.userId || getUserIdentifier(req);
    
    // Load stored memories for this user
    const memories = loadMemories(userId);
    
    // Check if user has memories (returning user)
    const isReturningUser = memories && memories.length > 0;
    
    if (isReturningUser) {
      // Generate personalized welcome message using AI
      try {
        if (!openai) {
          // Fallback to generic if AI not available
          return res.json({ 
            message: 'Welcome back to Stagify AI Designer! I can help you stage rooms, answer questions, and assist with interior design. How can I help you today?',
            isReturning: true
          });
        }
        
        // Build context from memories
        let memoriesContext = '';
        if (memories.length > 0) {
          memoriesContext = '\n\nUser information:\n';
          memories.forEach((memory, index) => {
            memoriesContext += `${index + 1}. ${memory.content}\n`;
          });
        }
        
        const prompt = `Generate a brief, friendly, personalized welcome message for a returning user of Stagify AI Designer.${memoriesContext}

The message should:
- Be warm and welcoming
- Reference something from their previous interactions if relevant
- Be concise (2-3 sentences)
- Mention that you're ready to help with room staging, design questions, or other requests
- Sound natural and conversational

Just return the message text, no additional formatting.`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: 'You are a friendly AI assistant for Stagify.ai. Generate brief, personalized welcome messages.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.7,
      max_tokens: 150
    });
        
        const personalizedMessage = completion.choices[0].message.content.trim();
        
        return res.json({ 
          message: personalizedMessage,
          isReturning: true
        });
      } catch (error) {
        console.error('Error generating personalized welcome message:', error);
        // Fallback to generic
        return res.json({ 
          message: 'Welcome back to Stagify AI Designer! I can help you stage rooms, answer questions, and assist with interior design. How can I help you today?',
          isReturning: true
        });
      }
    } else {
      // First-time user - return generic welcome message
      return res.json({ 
        message: 'Hello! I\'m Stagify AI Designer, your AI assistant for room staging and interior design. I can help you:\n• Stage rooms by uploading images and describing your desired style\n• Answer questions about interior design and home staging\n• Modify and refine staged room designs\n• Convert your top-down floorplans into 3D renders\n\nUpload an image of a room to get started, or ask me anything about interior design!',
        isReturning: false
      });
    }
  } catch (error) {
    console.error('Error in welcome message endpoint:', error);
    // Fallback to generic message
    res.json({ 
      message: 'Hello! I\'m Stagify AI Designer, your AI assistant for room staging and interior design. Upload an image of a room to get started, or ask me anything!',
      isReturning: false
    });
  }
});

// Chat endpoints
// Text chat endpoint
app.post('/api/chat', async (req, res) => {
  try {
    if (!openai) {
      return res.status(500).json({ error: 'AI service not properly configured' });
    }

    const { messages, model } = req.body;
    
    // Get model from request or default to gpt-4o-mini
    const selectedModel = model || 'gpt-4o-mini';
    
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Messages array is required' });
    }

    // Deduplicate messages to prevent double counting
    const deduplicatedMessages = deduplicateMessages(messages);
    if (deduplicatedMessages.length !== messages.length) {
      const removedCount = messages.length - deduplicatedMessages.length;
      console.log(`[Deduplication] Removed ${removedCount} duplicate message(s) from ${messages.length} total messages`);
      if (DEBUG_MODE) {
        // Log which messages were duplicates
        const seenKeys = new Set();
        messages.forEach((msg, idx) => {
          const key = Array.isArray(msg.content) 
            ? `${msg.role}:${JSON.stringify(msg.content.map(item => item.type === 'text' ? item.text : item.type))}`
            : `${msg.role}:${typeof msg.content === 'string' ? msg.content.trim() : 'non-string'}`;
          if (seenKeys.has(key)) {
            console.log(`[Deduplication] Duplicate found at index ${idx}: ${msg.role} message`);
          } else {
            seenKeys.add(key);
          }
        });
      }
    }
    
    // Check message limit (20 user messages max)
    const userMessageCount = deduplicatedMessages.filter(msg => msg.role === 'user').length;
    if (userMessageCount >= 20) {
      return res.json({
        response: "You've reached the maximum conversation context limit (20 messages). Please reload the chat by clicking the reload button (↻) to the left of the file upload button to start a fresh conversation.",
        contextLimitReached: true
      });
    }

    // Get user identifier
    const userId = getUserIdentifier(req);
    
    // Load stored memories for this user
    let memories = loadMemories(userId);
    
    // Build context about available images in history with annotations
    const { imageContext, imagesSentToGPT, originalImageIndex } = buildImageContext(deduplicatedMessages);
    
    // Log image context for debugging
    if (imageContext) {
      console.log('=== IMAGE CONTEXT SENT TO AI (CHAT) ===');
      console.log(imageContext);
      console.log('========================================');
    } else {
      console.log('[Image Context] No images in conversation history');
    }
    
    // Build system instruction with memories
    let systemInstruction = 'You are a helpful AI assistant for Stagify.ai, a room staging and interior design service. ';
    systemInstruction += 'Your primary purpose is to help users with room staging, interior design, and home decoration. ';
    systemInstruction += 'You can help users stage rooms by processing their images, answer questions about interior design, and provide design advice. ';
    systemInstruction += '\n\nCRITICAL: Stay on topic. Your primary focus is room staging and interior design, but you can:';
    systemInstruction += '\n- Have friendly, introductory conversations and get to know the user';
    systemInstruction += '\n- Answer questions about room staging and interior design';
    systemInstruction += '\n- Discuss home decoration, furniture, design styles, color schemes, and layouts';
    systemInstruction += '\n- Explain Stagify.ai features and functionality';
    systemInstruction += '\n- Help with file uploads and image processing';
    systemInstruction += '\n\nIf a user asks about completely unrelated topics (such as writing essays, general knowledge questions, or subjects that have nothing to do with design or your service), politely redirect them. However, feel free to be conversational, friendly, and engage in introductory small talk.';
    systemInstruction += '\n\nIMPORTANT: Check file types. Supported file types are: images (JPEG, JPG, PNG, WebP, GIF), PDFs, and text files. ';
    systemInstruction += 'If a user uploads an unsupported file type, you must inform them clearly which file type is not supported. ';
    systemInstruction += 'For example: "I\'m sorry, but [filename.xyz] is not a supported file type. Supported types are: images (JPEG, JPG, PNG, WebP, GIF), PDFs, and text files." ';
    systemInstruction += '\n\nIMPORTANT: Previous messages may reference files with placeholders like "[Image: filename.jpg]" or "[Staged image: filename.jpg]". These are references to files that were uploaded or generated in previous messages. The actual file data is NOT included to save bandwidth. Only files from the CURRENT message have their actual data included.';
    systemInstruction += imageContext;
    if (memories.length > 0) {
      systemInstruction += '\n\nImportant information to remember:\n';
      memories.forEach((memory, index) => {
        systemInstruction += `${index + 1}. ${memory.content}\n`;
      });
    }
    systemInstruction += '\n\nYou must respond with a JSON object containing:';
    systemInstruction += '\n- "response": Your text response to the user';
    systemInstruction += '\n- "memories": { "stores": ["memory description 1", ...], "forgets": ["memory ID 1", ...] } - Store or forget memories based on the conversation. To forget ALL memories, use "forgets": ["all"]';
    systemInstruction += '\n- "staging": { "shouldStage": true/false, "roomType": "Living room"|"Bedroom"|"Kitchen"|"Bathroom"|"Dining room"|"Office"|"Other", "additionalPrompt": "detailed staging description", "removeFurniture": true/false, "usePreviousImage": false|0|1|2|..., "furnitureImageIndex": null|0|1|2|... } OR "staging": [ { "shouldStage": true, ... }, { "shouldStage": true, ... }, ... ] - Request staging if the user wants to stage/modify a room image (ONLY use staging when the user has uploaded or is referring to an existing room image to modify). If the user wants to add a specific piece of furniture from a previous message, set "furnitureImageIndex" to the index of that furniture image (0 = most recent image, 1 = second most recent, etc.). You can provide MULTIPLE staging requests (up to 3) in an array if the user asks for multiple variations (e.g., "stage this room in 3 different themes"). Each staging request in the array will be processed separately.';
    systemInstruction += '\n- "imageRequest": { "requestImage": true/false, "imageIndex": 0|1|2|... } - Request to view/analyze a previous image by index (0 = most recent, 1 = second most recent, etc.). Use this when the user asks to "show me", "see", "view", or "display" a previous image. The image will be displayed to the user. If the user also wants analysis/description, the system will analyze it automatically.';
    systemInstruction += '\n- "recall": { "shouldRecall": true/false, "imageIndex": 0|1|2|... } - Recall and display a previous image by index (0 = most recent, 1 = second most recent, etc.). Use this when the user asks to "see", "show", "recall", or "bring back" an old image. This works for ANY image in the conversation history: user-uploaded images, staged images, generated images, and CAD renders. This is simpler than imageRequest - it just retrieves and displays the image without analysis. If user says "original image", "first image", or "initial image", use the original image index shown above.';
    systemInstruction += '\n- "generate": { "shouldGenerate": true/false, "prompt": "detailed image generation prompt" } OR "generate": [ { "shouldGenerate": true, "prompt": "..." }, { "shouldGenerate": true, "prompt": "..." }, ... ] - Generate a completely new image from text description (ONLY use generation when the user wants to create a NEW image from scratch, NOT when they want to modify an existing room image. If they uploaded an image or are referring to a previous image, use staging instead). You can provide MULTIPLE generation requests (up to 3) in an array if the user asks for multiple variations. Each generation request in the array will be processed separately.';
    systemInstruction += '\n\nIMPORTANT DISTINCTION:\n- Use "staging" when: user uploaded a room photo (3D perspective view of an interior space), user refers to a previous room photo with "CAD: False", user wants to modify/redesign an existing room photo that is NOT a CAD-staged image\n- Use "cad" (CAD-staging) when: (1) user uploaded a blueprint/floor plan (2D top-down architectural drawing), (2) user refers to a previous blueprint, (3) user says "stage" but the image is a blueprint/floor plan, OR (4) user wants to modify an image that has "CAD: True" in the image context - ALWAYS use CAD-staging for blueprints and CAD-staged images, even if the user says "stage"\n- Use "generate" when: user wants to create a completely new image from text only (no existing image involved), user asks to "generate", "create", "draw", or "make" an image of something that is NOT a room modification';
    systemInstruction += '\n\nSTAGING RULES (for room photos only):';
    systemInstruction += '\n- CRITICAL: Regular staging is ONLY for room photos (3D perspective interior views). If the user uploads or refers to a blueprint/floor plan (2D top-down architectural drawing), use CAD-staging ("cad" field) instead, even if they say "stage".';
    systemInstruction += '\n- CRITICAL: Before using regular staging, check the image context above. If the image you are modifying has "CAD: True" in its annotation, you MUST use CAD-staging ("cad" field) instead, NOT regular staging. This includes images you previously created with CAD-staging - if a user asks to modify a CAD-staged image, use CAD-staging again.';
    systemInstruction += '\n- Set "shouldStage": true if the user wants to stage a room photo, modify a room photo, change colors/walls/furniture, or apply any visual changes to a room photo (NOT a blueprint, and NOT a CAD-staged image with CAD: True)';
    systemInstruction += '\n- Set "usePreviousImage": false if using the current message\'s image, or the index (0 = most recent, 1 = second most recent, etc.) if modifying a previous image';
    systemInstruction += '\n- If user says "original image", "first image", or "initial image", use the original image index shown above';
    systemInstruction += '\n- Set "furnitureImageIndex" to the index of a furniture image from a previous message if the user wants to add a specific piece of furniture (e.g., "add that chair", "include the red sofa from before"). The furniture image will be sent to the staging system alongside the room image.';
    systemInstruction += '\n- The "additionalPrompt" should be a detailed, comprehensive description of the staging request';
    systemInstruction += '\n- If "shouldStage" is false, you can omit the "staging" field or set it to null';
    systemInstruction += '\n\nIMAGE REQUEST RULES:';
    systemInstruction += '\n- Set "requestImage": true if the user asks to see, describe, analyze, or look at a previous image';
    systemInstruction += '\n- Set "imageIndex" to the index of the image (0 = most recent, 1 = second most recent, etc.)';
    systemInstruction += '\n- If user says "original image", "first image", or "initial image", use the original image index shown above';
    systemInstruction += '\n- If "requestImage" is false, you can omit the "imageRequest" field or set it to null';
    systemInstruction += '\n\nRECALL RULES:';
    systemInstruction += '\n- Set "shouldRecall": true if the user asks to see, show, recall, or bring back an old image';
    systemInstruction += '\n- You can recall ANY image from the conversation: user-uploaded images, images you staged, images you generated, or CAD-staging renders you created';
    systemInstruction += '\n- Set "imageIndex" to the index of the image (0 = most recent, 1 = second most recent, etc.)';
    systemInstruction += '\n- Check the "Available images in conversation history" list above to find the correct index for any image (including your own generated/staged images)';
    systemInstruction += '\n- If user says "original image", "first image", or "initial image", use the original image index shown above';
    systemInstruction += '\n- If user asks to see "the image I generated" or "the staged image", look for "generated image" or "staged image" in the image list above';
    systemInstruction += '\n- If "shouldRecall" is false, you can omit the "recall" field or set it to null';
    systemInstruction += '\n\nCAD-STAGING RULES (for blueprints/floor plans and CAD-staged images):';
    systemInstruction += '\n- "cad": { "shouldProcessCAD": true/false, "imageIndex": 0|1|2|..., "furnitureImageIndex": null|0|1|2|...|[...], "additionalPrompt": "detailed CAD-staging description" } OR "cad": [ { "shouldProcessCAD": true, ... }, { "shouldProcessCAD": true, ... }, ... ] - CAD-staging processes a top-down blueprint/floor plan image to create a 3D render. This is DIFFERENT from regular staging. Use CAD-staging when: (1) the user uploads a top-down blueprint, floor plan, or architectural drawing (2D plan view from above), OR (2) the user wants to modify an image that has "CAD: True" in its annotation (check the image context above). CRITICAL: Even if the user says "stage this blueprint" or "stage this floor plan", you MUST use CAD-staging (set "shouldProcessCAD": true), NOT regular staging. CRITICAL: If the user asks to modify a previously CAD-staged image (one with "CAD: True" in the image context), you MUST use CAD-staging again, NOT regular staging. Regular staging is ONLY for room photos (3D perspective views), NOT for blueprints or CAD-staged images. Set "imageIndex" to the index of the blueprint or CAD-staged image (0 = most recent, 1 = second most recent, etc.). If the user uploads a blueprint in the current message, use imageIndex 0. If the user wants to include specific furniture pieces in the 3D render, set "furnitureImageIndex" to the index (or array of indices) of the furniture image(s) from previous messages. The "additionalPrompt" should be a detailed description of any specific requirements, themes, styles, or preferences the user has (e.g., "medieval theme", "modern minimalist", "cozy atmosphere", etc.). The CAD-staging function will convert the blueprint to a top-down 3D render and include the furniture and styling preferences if specified. You can provide MULTIPLE CAD requests (up to 3) in an array if the user asks for multiple variations (e.g., "stage this blueprint in 3 different themes"). Each CAD request in the array will be processed separately.';
    systemInstruction += '\n- CRITICAL: If the user uploads or refers to a blueprint/floor plan (2D top-down architectural drawing), you MUST set "shouldProcessCAD": true, even if they say "stage". Blueprints ALWAYS use CAD-staging, never regular staging.';
    systemInstruction += '\n- CRITICAL: If the user asks to modify an image that has "CAD: True" in the image context above, you MUST use CAD-staging ("cad" field), NOT regular staging. Always check the CAD classification in the image annotations before deciding which pipeline to use.';
    systemInstruction += '\n- CRITICAL: Regular staging ("staging" field) is ONLY for room photos (3D perspective interior views). If you see a blueprint/floor plan OR an image with "CAD: True", use CAD-staging instead.';
    systemInstruction += '\n- Set "furnitureImageIndex" to the index (or array of indices) of furniture images from previous messages if the user wants to include specific furniture in the 3D render';
    systemInstruction += '\n- If "shouldProcessCAD" is false, you can omit the "cad" field or set it to null';

    // Get the last user message
    const lastUserMessage = messages.filter(m => m.role === 'user').pop();
    const lastUserMessageText = lastUserMessage ? (typeof lastUserMessage.content === 'string' ? lastUserMessage.content : '') : '';
    
    // Check if there are images in conversation history (from user uploads or staged images)
    let hasImageInHistory = false;
    let imageFromHistory = null;
    let isStagedImage = false;
    
    // First, check for staged images (from assistant messages) - prioritize these for modifications
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        const imageItem = msg.content.find(item => item.type === 'image_url' && item.isStaged);
        if (imageItem && imageItem.image_url && imageItem.image_url.url) {
          hasImageInHistory = true;
          imageFromHistory = imageItem.image_url.url;
          isStagedImage = true;
          console.log(`[Staging] Found staged image in conversation history`);
          break;
        }
      }
    }
    
    // If no staged image found, check for user-uploaded images
    if (!hasImageInHistory) {
      for (let i = deduplicatedMessages.length - 1; i >= 0; i--) {
        const msg = deduplicatedMessages[i];
        if (msg.role === 'user' && Array.isArray(msg.content)) {
          const imageItem = msg.content.find(item => item.type === 'image_url');
          if (imageItem && imageItem.image_url && imageItem.image_url.url) {
            hasImageInHistory = true;
            imageFromHistory = imageItem.image_url.url;
            console.log(`[Staging] Found user-uploaded image in conversation history`);
            break;
          }
        }
      }
    }

    // Strip images from conversation history (except current message) to prevent payload size issues
    // Only send text context, images will be requested via special mechanism if needed
    const strippedMessages = stripImagesFromHistory(deduplicatedMessages, true); // Keep images in current message only
    
    // Apply middleman filter to remove unsupported files
    const filteredMessages = filterConversationHistory(strippedMessages);
    
    const openaiMessages = [
      { role: 'system', content: systemInstruction },
      ...await Promise.all(filteredMessages.map(async (msg) => {
        if (msg.role === 'user' && Array.isArray(msg.content)) {
          // User message with images - only current message has images, apply filter
          const { filteredContent } = filterUnsupportedFiles(msg.content);
          // Clean image objects - remove extra properties that OpenAI doesn't accept and downscale images
          const cleanedContent = await Promise.all(filteredContent.map(async (item) => {
            if (item.type === 'image_url' && item.image_url && item.image_url.url) {
              // Downscale image if needed before sending to GPT
              const downscaledUrl = await downscaleImageForGPT(item.image_url.url);
              // Only keep the structure OpenAI expects: { type: 'image_url', image_url: { url: '...' } }
              return {
                type: 'image_url',
                image_url: {
                  url: downscaledUrl
                }
              };
            }
            return item;
          }));
          return {
            role: 'user',
            content: cleanedContent
          };
        } else {
          // All other messages are text-only (images stripped)
          return {
            role: msg.role === 'user' ? 'user' : 'assistant',
            content: msg.content
          };
        }
      }))
    ];

    // Debug logging - log what's being sent to AI (ALWAYS log, not just in DEBUG_MODE)
    const messagesJson = JSON.stringify(openaiMessages);
    const payloadSize = Buffer.byteLength(messagesJson, 'utf8');
    const payloadSizeKB = (payloadSize / 1024).toFixed(2);
    const payloadSizeMB = (payloadSize / (1024 * 1024)).toFixed(2);
    
    console.log('=== SENDING TO AI (CHAT) ===');
    console.log('Payload size:', payloadSize, 'bytes (', payloadSizeKB, 'KB /', payloadSizeMB, 'MB)');
    console.log('Number of messages:', openaiMessages.length);
    
    if (DEBUG_MODE) {
      // Log individual messages instead of full array
      console.log('--- MESSAGES ---');
      openaiMessages.forEach((msg, index) => {
        if (msg.role === 'system') {
          console.log(`Message ${index + 1} [SYSTEM]:`, msg.content.substring(0, 500) + (msg.content.length > 500 ? '... [truncated]' : ''));
        } else if (msg.role === 'user') {
          if (Array.isArray(msg.content)) {
            const textItems = msg.content.filter(item => item.type === 'text');
            const imageItems = msg.content.filter(item => item.type === 'image_url');
            const textContent = textItems.map(item => item.text).join(' ');
            console.log(`Message ${index + 1} [USER]: Text: "${textContent.substring(0, 200)}${textContent.length > 200 ? '...' : ''}" | Images: ${imageItems.length}`);
          } else {
            console.log(`Message ${index + 1} [USER]:`, msg.content.substring(0, 200) + (msg.content.length > 200 ? '...' : ''));
          }
        } else if (msg.role === 'assistant') {
          if (Array.isArray(msg.content)) {
            const textItems = msg.content.filter(item => item.type === 'text');
            const textContent = textItems.map(item => item.text).join(' ');
            console.log(`Message ${index + 1} [ASSISTANT]:`, textContent.substring(0, 200) + (textContent.length > 200 ? '...' : ''));
          } else {
            console.log(`Message ${index + 1} [ASSISTANT]:`, msg.content.substring(0, 200) + (msg.content.length > 200 ? '...' : ''));
          }
        }
      });
      console.log('----------------');
    }
    
    // Log image data sizes if present
    openaiMessages.forEach((msg, idx) => {
      if (msg.role === 'user' && Array.isArray(msg.content)) {
        msg.content.forEach((item, itemIdx) => {
          if (item.type === 'image_url' && item.image_url && item.image_url.url) {
            const imageDataSize = Buffer.byteLength(item.image_url.url, 'utf8');
            console.log(`Message ${idx}, Image ${itemIdx}: ${(imageDataSize / 1024).toFixed(2)} KB`);
          }
        });
      }
    });
    
    console.log('============================');

    // Use OpenAI GPT with JSON response format
    console.log('Calling OpenAI API...');
    let aiResponseJson;
    try {
      const completion = await openai.chat.completions.create({
        model: selectedModel,
        messages: openaiMessages,
        temperature: getTemperatureForModel(selectedModel),
        response_format: { type: 'json_object' }
      });

      aiResponseJson = JSON.parse(completion.choices[0].message.content);
    } catch (gptError) {
      console.error('[GPT] Error calling OpenAI API:', gptError);
      console.error('[GPT] Error stack:', gptError.stack);
      return res.status(500).json({ 
        error: 'Failed to get AI response', 
        details: 'The AI service encountered an error. Please try again.',
        response: 'I apologize, but I encountered an error processing your request. Please try again.'
      });
    }
    let text = aiResponseJson.response || completion.choices[0].message.content;
    const memoryActionsFromAI = aiResponseJson.memories || { stores: [], forgets: [] };
    const stagingRequestFromAI = aiResponseJson.staging || null;
    const imageRequestFromAI = aiResponseJson.imageRequest || null;
    const recallRequestFromAI = aiResponseJson.recall || null;
    const generateRequestFromAI = aiResponseJson.generate || null;
    const cadRequestFromAI = aiResponseJson.cad || null;
    
    // Log chat to CSV file
    const ipAddress = req.ip || req.connection?.remoteAddress || 'unknown';
    const userAgent = req.get('user-agent') || 'unknown';
    logChatToFile(userId, lastUserMessageText, text, [], ipAddress, userAgent);
    
    // Debug logging
    if (DEBUG_MODE) {
      console.log('=== AI CHAT DEBUG ===');
      console.log('User ID:', userId);
      console.log('User message:', lastUserMessageText);
      console.log('AI response:', text);
      console.log('Memories loaded:', memories.length);
      if (memories.length > 0) {
        console.log('Memories:', memories.map(m => m.content).join(', '));
      }
      console.log('====================');
    }

    // Process memory actions from AI response
    const memoryActions = { stores: [], forgets: [] };
    if (lastUserMessageText && memoryActionsFromAI) {
      console.log(`[Memory] Processing memory actions from AI response:`, memoryActionsFromAI);
      
      // Process forget actions first
      if (memoryActionsFromAI.forgets && memoryActionsFromAI.forgets.length > 0) {
        // Check if user wants to forget all memories
        if (memoryActionsFromAI.forgets.includes('all')) {
          const forgottenCount = memories.length;
          memories = [];
          memoryActions.forgets = ['all'];
          console.log(`Forgot ALL ${forgottenCount} memories for user ${userId}`);
        } else {
          // Process individual memory forgets
          for (const memoryId of memoryActionsFromAI.forgets) {
            const initialLength = memories.length;
            // Try exact ID match first
            memories = memories.filter(m => m.id !== memoryId);
            
            if (memories.length < initialLength) {
              memoryActions.forgets.push(memoryId);
              console.log(`Forgot memory with ID for user ${userId}:`, memoryId);
            } else {
              // Try to find by content match if ID didn't work
              const memoryToForget = memories.find(m => 
                m.content.toLowerCase().includes(memoryId.toLowerCase()) ||
                memoryId.toLowerCase().includes(m.content.toLowerCase()) ||
                m.id.includes(memoryId) ||
                memoryId.includes(m.id)
              );
              
              if (memoryToForget) {
                memories = memories.filter(m => m.id !== memoryToForget.id);
                memoryActions.forgets.push(memoryToForget.id);
                console.log(`Forgot memory for user ${userId}:`, memoryToForget.content);
              }
            }
          }
        }
      }
      
      // Process store actions
      if (memoryActionsFromAI.stores && memoryActionsFromAI.stores.length > 0) {
        for (const memoryContent of memoryActionsFromAI.stores) {
          if (memoryContent && memoryContent.trim()) {
            const newMemory = {
              id: Date.now().toString() + '_' + Math.random().toString(36).substr(2, 9),
              content: memoryContent.trim(),
              timestamp: new Date().toISOString(),
              userMessage: lastUserMessageText.substring(0, 100) // Store first 100 chars for context
            };
            memories.push(newMemory);
            memoryActions.stores.push(newMemory.content);
            console.log(`Stored new memory for user ${userId}:`, newMemory.content);
          }
        }
      }
      
      // Save memories if any changes were made
      if (memoryActions.stores.length > 0 || memoryActions.forgets.length > 0) {
        saveMemories(userId, memories);
      }
    }

    // Process image generation request(s) from AI response (supports single or array)
    let generatedImages = [];
    
    if (generateRequestFromAI) {
      // Normalize to array (max 3)
      const generateRequests = Array.isArray(generateRequestFromAI) 
        ? generateRequestFromAI.slice(0, 3).filter(g => g.shouldGenerate && g.prompt)
        : (generateRequestFromAI.shouldGenerate && generateRequestFromAI.prompt ? [generateRequestFromAI] : []);
      
      if (generateRequests.length > 0) {
        console.log(`[Image Generation] Processing ${generateRequests.length} generation request(s) from AI`);
        
        for (let i = 0; i < generateRequests.length; i++) {
          const genRequest = generateRequests[i];
          try {
            console.log(`[Image Generation] Processing generation request ${i + 1}/${generateRequests.length}:`, genRequest.prompt.substring(0, 100) + '...');
            const geminiModel = getGeminiImageModel(selectedModel);
            const generatedImage = await processImageGeneration(genRequest.prompt, req, geminiModel);
            if (generatedImage) {
              // Annotate generated image in parallel
              const annotationPromise = annotateImage(generatedImage).then(annotation => {
                console.log(`[Image Annotation] Annotation for generated image ${i + 1}: ${annotation || 'failed'}`);
                return annotation;
              }).catch(err => {
                console.error(`[Image Annotation] Error annotating generated image ${i + 1}:`, err);
                return null;
              });
              
              generatedImages.push({
                image: generatedImage,
                annotationPromise: annotationPromise
              });
              console.log(`[Image Generation] Successfully generated image ${i + 1}/${generateRequests.length}`);
            }
          } catch (error) {
            console.error(`[Image Generation] Error generating image ${i + 1}:`, error);
            // Continue with other images if one fails
          }
        }
        
        if (generateRequests.length > 0 && generatedImages.length === 0) {
          text = text + '\n\nSorry, I encountered an error while generating the images. Please try again.';
        }
      }
    }
    
    // Process staging request(s) from AI response (supports single or array)
    let stagingResults = [];
    
    if (stagingRequestFromAI) {
      // Normalize to array (max 3)
      const stagingRequests = Array.isArray(stagingRequestFromAI)
        ? stagingRequestFromAI.slice(0, 3).filter(s => s.shouldStage)
        : (stagingRequestFromAI.shouldStage ? [stagingRequestFromAI] : []);
      
      if (stagingRequests.length > 0) {
        console.log(`[Staging] Processing ${stagingRequests.length} staging request(s) from AI`);
        
        for (let i = 0; i < stagingRequests.length; i++) {
          const stagingRequest = stagingRequests[i];
          console.log(`[Staging] Processing staging request ${i + 1}/${stagingRequests.length}:`, stagingRequest);
          
          // Build staging params from AI response
          let stagingParams = {
            roomType: stagingRequest.roomType || 'Other',
            furnitureStyle: 'custom', // Always use custom
            additionalPrompt: stagingRequest.additionalPrompt || '',
            removeFurniture: stagingRequest.removeFurniture || false,
            usePreviousImage: stagingRequest.usePreviousImage !== undefined ? stagingRequest.usePreviousImage : false,
            furnitureImageIndex: stagingRequest.furnitureImageIndex !== undefined && stagingRequest.furnitureImageIndex !== null ? stagingRequest.furnitureImageIndex : null
          };
          
          // Fallback: If user mentions "original", "first", or "initial" image but AI didn't set usePreviousImage correctly
          const messageLower = lastUserMessageText.toLowerCase();
          const hasOriginalKeywords = messageLower.includes('original') || 
                                      messageLower.includes('first image') || 
                                      messageLower.includes('initial image') ||
                                      messageLower.includes('go back to') ||
                                      messageLower.includes('refer back to');
          
          if (hasOriginalKeywords && (stagingParams.usePreviousImage === false || stagingParams.usePreviousImage === null)) {
            // Find the original (first) user-uploaded image
            const originalImageIndex = getOriginalImageIndex(messages);
            if (originalImageIndex !== null) {
              console.log(`[Staging] Fallback: User mentioned "original" but AI didn't set usePreviousImage. Overriding to use original image at index ${originalImageIndex}`);
              stagingParams.usePreviousImage = originalImageIndex;
            } else {
              // If no original found, use most recent (index 0)
              console.log(`[Staging] Fallback: User mentioned "original" but no original image found. Using most recent image (index 0) as fallback`);
              stagingParams.usePreviousImage = 0;
            }
          }
          
          if (stagingParams) {
            try {
              let imageBuffer = null;
              let imageSource = '';
              
              // Determine which image to use based on usePreviousImage
              if (stagingParams.usePreviousImage !== false && stagingParams.usePreviousImage !== null) {
              // AI requested a previous image - use the AI's chosen index (AI should use context to determine the correct image)
              const imageIndex = typeof stagingParams.usePreviousImage === 'number' ? stagingParams.usePreviousImage : 0;
              console.log(`[Staging] Looking for image at index ${imageIndex}`);
              
              const previousImage = getImageFromHistory(messages, imageIndex);
              
              if (previousImage && previousImage.url) {
                const base64Data = previousImage.url.split(',')[1];
                if (base64Data) {
                  imageBuffer = Buffer.from(base64Data, 'base64');
                  imageSource = previousImage.isStaged ? `staged image (index ${imageIndex})` : `user-uploaded image (index ${imageIndex})`;
                  console.log(`[Staging] Using previous ${imageSource}`);
                } else {
                  console.log(`[Staging] Previous image found but base64 data extraction failed`);
                }
              } else {
                console.log(`[Staging] Previous image at index ${imageIndex} not found`);
                // Fallback: try to use the most recent image (index 0) if requested index doesn't exist
                if (imageIndex > 0) {
                  console.log(`[Staging] Attempting fallback to index 0`);
                  const fallbackImage = getImageFromHistory(messages, 0);
                  if (fallbackImage && fallbackImage.url) {
                    const base64Data = fallbackImage.url.split(',')[1];
                    if (base64Data) {
                      imageBuffer = Buffer.from(base64Data, 'base64');
                      imageSource = fallbackImage.isStaged ? `staged image (fallback to index 0)` : `user-uploaded image (fallback to index 0)`;
                      console.log(`[Staging] Using fallback ${imageSource}`);
                    }
                  }
                }
              }
            } else if (imageFromHistory) {
              // Fallback to old logic if usePreviousImage is false but we have imageFromHistory
              const base64Data = imageFromHistory.split(',')[1];
              if (base64Data) {
                imageBuffer = Buffer.from(base64Data, 'base64');
                imageSource = isStagedImage ? 'staged image' : 'conversation history';
                console.log(`[Staging] Using image from conversation history (fallback)`);
              }
            }
            
            // Retrieve furniture image if specified
            let furnitureImageBuffer = null;
            if (stagingParams.furnitureImageIndex !== null && stagingParams.furnitureImageIndex !== undefined) {
              const furnitureIndex = typeof stagingParams.furnitureImageIndex === 'number' ? stagingParams.furnitureImageIndex : null;
              if (furnitureIndex !== null) {
                console.log(`[Staging] Looking for furniture image at index ${furnitureIndex}`);
                const furnitureImage = getImageFromHistory(messages, furnitureIndex);
                
                if (furnitureImage && furnitureImage.url) {
                  const base64Data = furnitureImage.url.split(',')[1];
                  if (base64Data) {
                    furnitureImageBuffer = Buffer.from(base64Data, 'base64');
                    console.log(`[Staging] Found furniture image at index ${furnitureIndex}`);
                  }
                } else {
                  console.log(`[Staging] Furniture image at index ${furnitureIndex} not found`);
                }
              }
            }
            
            if (imageBuffer) {
              try {
                const geminiModel = getGeminiImageModel(selectedModel);
                const stagedImage = await processStaging(imageBuffer, stagingParams, req, furnitureImageBuffer, geminiModel);
                if (stagedImage) {
                  // Annotate staged image in parallel
                  const annotationPromise = annotateImage(stagedImage).then(annotation => {
                    console.log(`[Image Annotation] Annotation for staged image ${i + 1}: ${annotation || 'failed'}`);
                    return annotation;
                  }).catch(err => {
                    console.error(`[Image Annotation] Error annotating staged image ${i + 1}:`, err);
                    return null;
                  });
                  
                  stagingResults.push({
                    stagedImage: stagedImage,
                    params: stagingParams,
                    annotationPromise: annotationPromise
                  });
                  console.log(`[Staging] Successfully processed staging ${i + 1}/${stagingRequests.length} for user ${userId} from ${imageSource}${furnitureImageBuffer ? ' with furniture image' : ''}`);
                }
              } catch (stagingError) {
                console.error(`[Staging] Error processing staging ${i + 1}:`, stagingError);
                console.error(`[Staging] Error stack:`, stagingError.stack);
                // Continue with other staging requests if one fails
                // Add error message to text response
                if (stagingRequests.length === 1) {
                  text = (text || '') + '\n\nSorry, I encountered an error while staging the room. Please try again.';
                }
              }
            } else {
              console.log(`[Staging] No image found for staging ${i + 1}`);
              if (stagingRequests.length === 1) {
                text = (text || '') + '\n\nSorry, I couldn\'t find the image to stage. Please make sure you\'ve uploaded an image.';
              }
            }
          } catch (error) {
            console.error(`[Staging] Error in staging request ${i + 1}:`, error);
            console.error(`[Staging] Error stack:`, error.stack);
            // Continue with other staging requests if one fails
            if (stagingRequests.length === 1) {
              text = (text || '') + '\n\nSorry, I encountered an error while processing the staging request. Please try again.';
            }
          }
          }
        }
      }
    }

    // Process recall request from AI response (simpler than imageRequest - just retrieves and displays)
    let recalledImageForDisplay = null;
    if (recallRequestFromAI && recallRequestFromAI.shouldRecall) {
      try {
        const imageIndex = typeof recallRequestFromAI.imageIndex === 'number' ? recallRequestFromAI.imageIndex : 0;
        console.log(`[Recall] Processing recall request from AI, index: ${imageIndex}`);
        
        // Retrieve the image from conversation history
        const recalledImage = getImageFromHistory(messages, imageIndex);
        
        if (recalledImage && recalledImage.url) {
          console.log(`[Recall] Found image at index ${imageIndex}`);
          recalledImageForDisplay = recalledImage.url;
        } else {
          console.log(`[Recall] Image at index ${imageIndex} not found`);
        }
      } catch (error) {
        console.error('Error processing recall request:', error);
        // Continue with original response if recall fails
      }
    }

    // Process image request from AI response
    let requestedImageForDisplay = null;
    if (imageRequestFromAI && imageRequestFromAI.requestImage) {
      try {
        const imageIndex = typeof imageRequestFromAI.imageIndex === 'number' ? imageRequestFromAI.imageIndex : 0;
        console.log(`[Image Request] Processing image request from AI, index: ${imageIndex}`);
        
        // Retrieve the image from conversation history
        const requestedImage = getImageFromHistory(messages, imageIndex);
        
        if (requestedImage && requestedImage.url) {
          console.log(`[Image Request] Found image at index ${imageIndex}`);
          
          // Store the image URL to return in response for display
          requestedImageForDisplay = requestedImage.url;
          
          // Check if user wants to analyze/describe the image (vs just view it)
          // Only analyze if explicitly asking for description/analysis, not just "show me"
          const messageLower = lastUserMessageText.toLowerCase();
          const wantsAnalysis = (messageLower.includes('describe') && !messageLower.includes('show')) || 
                               (messageLower.includes('analyze') && !messageLower.includes('show')) || 
                               (messageLower.includes('what') && messageLower.includes('in') && !messageLower.includes('show')) ||
                               messageLower.includes('tell me about') ||
                               (messageLower.includes('explain') && !messageLower.includes('show'));
          
          if (wantsAnalysis) {
            console.log(`[Image Request] User wants analysis, sending to GPT for analysis`);
            // Make another GPT call with the image for analysis
            const imageAnalysisMessages = [
              { role: 'system', content: systemInstruction },
              ...openaiMessages.slice(1), // Skip the original system message, keep the rest
              {
                role: 'user',
                content: [
                  { type: 'text', text: lastUserMessageText },
                  {
                    type: 'image_url',
                    image_url: {
                      url: await downscaleImageForGPT(requestedImage.url)
                    }
                  }
                ]
              }
            ];
            
            const imageAnalysisCompletion = await openai.chat.completions.create({
              model: selectedModel,
              messages: imageAnalysisMessages,
              temperature: getTemperatureForModel(selectedModel),
              response_format: { type: 'json_object' }
            });
            
            const imageAnalysisJson = JSON.parse(imageAnalysisCompletion.choices[0].message.content);
            text = imageAnalysisJson.response || imageAnalysisCompletion.choices[0].message.content;
            
            console.log(`[Image Request] Successfully analyzed image, response: ${text.substring(0, 100)}...`);
          } else {
            // User just wants to see the image - keep the original text response
            console.log(`[Image Request] User wants to view image, returning image for display`);
          }
        } else {
          console.log(`[Image Request] Image at index ${imageIndex} not found`);
        }
      } catch (error) {
        console.error('Error processing image request:', error);
        // Continue with original response if image request fails
      }
    }

    // Process CAD request(s) from AI response (supports single or array)
    let cadResults = [];
    
    if (cadRequestFromAI) {
      // Normalize to array (max 3)
      const cadRequests = Array.isArray(cadRequestFromAI)
        ? cadRequestFromAI.slice(0, 3).filter(c => c.shouldProcessCAD)
        : (cadRequestFromAI.shouldProcessCAD ? [cadRequestFromAI] : []);
      
      if (cadRequests.length > 0) {
        console.log(`[CAD] Processing ${cadRequests.length} CAD request(s) from AI`);
        
        for (let i = 0; i < cadRequests.length; i++) {
          const cadRequest = cadRequests[i];
          console.log(`[CAD] Processing CAD request ${i + 1}/${cadRequests.length}:`, cadRequest);
          
          try {
            const imageIndex = typeof cadRequest.imageIndex === 'number' ? cadRequest.imageIndex : 0;
            console.log(`[CAD] Processing CAD request from AI, index: ${imageIndex}`);
            
            // Retrieve the blueprint image from conversation history
            const blueprintImage = getImageFromHistory(messages, imageIndex);
            
            if (blueprintImage && blueprintImage.url) {
              console.log(`[CAD] Found blueprint image at index ${imageIndex}`);
              
              // Extract base64 data from the image URL
              const base64Data = blueprintImage.url.split(',')[1];
              if (base64Data) {
                const imageBuffer = Buffer.from(base64Data, 'base64');
                const mimeType = blueprintImage.url.match(/data:([^;]+)/)?.[1] || 'image/png';
                
                // Retrieve furniture images if specified
                const furnitureImages = [];
                if (cadRequest.furnitureImageIndex !== null && cadRequest.furnitureImageIndex !== undefined) {
                  const furnitureIndices = Array.isArray(cadRequest.furnitureImageIndex) 
                    ? cadRequest.furnitureImageIndex 
                    : [cadRequest.furnitureImageIndex];
                  
                  for (const furnitureIndex of furnitureIndices) {
                    if (furnitureIndex !== null && furnitureIndex !== undefined) {
                      const furnitureImage = getImageFromHistory(messages, furnitureIndex);
                      if (furnitureImage && furnitureImage.url) {
                        const furnitureBase64Data = furnitureImage.url.split(',')[1];
                        if (furnitureBase64Data) {
                          const furnitureBuffer = Buffer.from(furnitureBase64Data, 'base64');
                          const furnitureMimeType = furnitureImage.url.match(/data:([^;]+)/)?.[1] || 'image/png';
                          furnitureImages.push({
                            image: furnitureBuffer,
                            mimeType: furnitureMimeType
                          });
                          console.log(`[CAD] Found furniture image at index ${furnitureIndex}`);
                        }
                      } else {
                        console.log(`[CAD] Furniture image at index ${furnitureIndex} not found`);
                      }
                    }
                  }
                }
                
                console.log(`[CAD] Processing blueprint with CAD function${furnitureImages.length > 0 ? ` (with ${furnitureImages.length} furniture image(s))` : ''}${cadRequest.additionalPrompt ? ` (with additional prompt: ${cadRequest.additionalPrompt.substring(0, 50)}...)` : ''}...`);
                // Process the blueprint through CAD function
                const additionalPrompt = cadRequest.additionalPrompt || null;
                const cadResultBuffer = await blueprintTo3D(imageBuffer, mimeType, furnitureImages, additionalPrompt);
                
                // Convert result buffer to data URL
                const cadImageBase64 = cadResultBuffer.toString('base64');
                const cadImageForDisplay = `data:${mimeType};base64,${cadImageBase64}`;
                
                // Annotate CAD image in parallel
                const annotationPromise = annotateImage(cadImageForDisplay, true).then(annotation => {
                  console.log(`[Image Annotation] Annotation for CAD render ${i + 1}: ${annotation || 'failed'}`);
                  return annotation;
                }).catch(err => {
                  console.error(`[Image Annotation] Error annotating CAD render ${i + 1}:`, err);
                  return null;
                });
                
                cadResults.push({
                  cadImage: cadImageForDisplay,
                  params: cadRequest,
                  annotationPromise: annotationPromise
                });
                
                console.log(`[CAD] Successfully generated 3D render ${i + 1}/${cadRequests.length} from blueprint${furnitureImages.length > 0 ? ' with furniture' : ''}`);
              } else {
                console.log(`[CAD] Failed to extract base64 data from blueprint image`);
              }
            } else {
              console.log(`[CAD] Blueprint image at index ${imageIndex} not found`);
            }
          } catch (error) {
            console.error(`[CAD] Error processing CAD request ${i + 1}:`, error);
            // Continue with other CAD requests if one fails
            if (cadRequests.length === 1) {
              text = (text || '') + '\n\nSorry, I encountered an error while processing the CAD blueprint. Please try again.';
            }
          }
        }
      }
    }
    
    // Legacy support: maintain cadImageForDisplay and cadAnnotationPromise for backward compatibility
    let cadImageForDisplay = null;
    let cadAnnotationPromise = null;
    if (cadResults.length > 0) {
      cadImageForDisplay = cadResults[0].cadImage;
      cadAnnotationPromise = cadResults[0].annotationPromise;
    }

    // Wait for all annotations to complete before building response
    const stagedImageAnnotations = {};
    if (stagingResults.length > 0) {
      for (let i = 0; i < stagingResults.length; i++) {
        if (stagingResults[i].annotationPromise) {
          const annotation = await stagingResults[i].annotationPromise;
          if (annotation) {
            stagedImageAnnotations[`staged_${i}`] = annotation;
          }
        }
      }
    }
    
    const generatedImageAnnotations = {};
    if (generatedImages.length > 0) {
      for (let i = 0; i < generatedImages.length; i++) {
        if (generatedImages[i].annotationPromise) {
          const annotation = await generatedImages[i].annotationPromise;
          if (annotation) {
            generatedImageAnnotations[`generated_${i}`] = annotation;
          }
        }
      }
    }
    
    // Wait for all CAD annotations to complete
    const cadImageAnnotations = {};
    if (cadResults.length > 0) {
      for (let i = 0; i < cadResults.length; i++) {
        if (cadResults[i].annotationPromise) {
          const annotation = await cadResults[i].annotationPromise;
          if (annotation) {
            cadImageAnnotations[`cad_${i}`] = annotation;
          }
        }
      }
    }
    
    // Legacy support
    let cadImageAnnotation = null;
    if (cadImageForDisplay && cadAnnotationPromise) {
      cadImageAnnotation = await cadAnnotationPromise;
    }

    // Return JSON response with text, memory actions, staging result(s), generated image(s), and requested image if available
    const response = { 
      response: text,
      memories: memoryActions
    };
    
    // Handle multiple staging results
    if (stagingResults.length > 0) {
      if (stagingResults.length === 1) {
        // Single result - maintain backward compatibility
        response.stagedImage = stagingResults[0].stagedImage;
        response.stagingParams = stagingResults[0].params;
      } else {
        // Multiple results - return as array
        response.stagedImages = stagingResults.map(r => r.stagedImage);
        response.stagingParams = stagingResults.map(r => r.params);
      }
      // Include annotations if available
      if (Object.keys(stagedImageAnnotations).length > 0) {
        response.stagedImageAnnotations = stagedImageAnnotations;
      }
    }
    
    // Handle multiple generated images
    if (generatedImages.length > 0) {
      if (generatedImages.length === 1) {
        // Single result - maintain backward compatibility
        response.generatedImage = generatedImages[0].image || generatedImages[0];
      } else {
        // Multiple results - return as array
        response.generatedImages = generatedImages.map(g => g.image || g);
      }
      // Include annotations if available
      if (Object.keys(generatedImageAnnotations).length > 0) {
        response.generatedImageAnnotations = generatedImageAnnotations;
      }
    }
    
    if (requestedImageForDisplay) {
      response.requestedImage = requestedImageForDisplay;
    }
    
    if (recalledImageForDisplay) {
      response.recalledImage = recalledImageForDisplay;
    }
    
    // Handle multiple CAD results
    if (cadResults.length > 0) {
      if (cadResults.length === 1) {
        // Single result - maintain backward compatibility
        response.cadImage = cadResults[0].cadImage;
        if (cadImageAnnotation) {
          response.cadImageAnnotation = cadImageAnnotation;
        }
      } else {
        // Multiple results - return as array
        response.cadImages = cadResults.map(r => r.cadImage);
        response.cadParams = cadResults.map(r => r.params);
      }
      // Include annotations if available
      if (Object.keys(cadImageAnnotations).length > 0) {
        response.cadImageAnnotations = cadImageAnnotations;
      }
    }
    
    res.json(response);
  } catch (error) {
    console.error('Error in chat:', error);
    res.status(500).json({ 
      error: 'Chat processing failed', 
      details: error.message 
    });
  }
});

// Chat with file upload endpoint (multiple files)
app.post('/api/chat-upload', chatUpload.array('files', 10), async (req, res) => {
  try {
    if (!openai) {
      return res.status(500).json({ error: 'AI service not properly configured' });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files provided' });
    }

    // Get user identifier
    const userId = getUserIdentifier(req);
    
    // Load stored memories for this user
    let memories = loadMemories(userId);
    
    // Build system instruction with memories (base instruction, will add image context after parsing conversationHistory)
    let systemInstruction = 'You are a helpful AI assistant for Stagify.ai, a room staging and interior design service. ';
    systemInstruction += 'Your primary purpose is to help users with room staging, interior design, and home decoration. ';
    systemInstruction += 'You can help users stage rooms by processing their images, answer questions about interior design, and provide design advice. ';
    systemInstruction += '\n\nCRITICAL: Stay on topic. Your primary focus is room staging and interior design, but you can:';
    systemInstruction += '\n- Have friendly, introductory conversations and get to know the user';
    systemInstruction += '\n- Answer questions about room staging and interior design';
    systemInstruction += '\n- Discuss home decoration, furniture, design styles, color schemes, and layouts';
    systemInstruction += '\n- Explain Stagify.ai features and functionality';
    systemInstruction += '\n- Help with file uploads and image processing';
    systemInstruction += '\n\nIf a user asks about completely unrelated topics (such as writing essays, general knowledge questions, or subjects that have nothing to do with design or your service), politely redirect them. However, feel free to be conversational, friendly, and engage in introductory small talk.';
    systemInstruction += '\n\nIMPORTANT: Check file types. Supported file types are: images (JPEG, JPG, PNG, WebP, GIF), PDFs, and text files. ';
    systemInstruction += 'If a user uploads an unsupported file type, you must inform them clearly which file type is not supported. ';
    systemInstruction += 'For example: "I\'m sorry, but [filename.xyz] is not a supported file type. Supported types are: images (JPEG, JPG, PNG, WebP, GIF), PDFs, and text files." ';
    systemInstruction += '\n\nIMPORTANT: Previous messages may reference files with placeholders like "[Image: filename.jpg]" or "[Staged image: filename.jpg]". These are references to files that were uploaded or generated in previous messages. The actual file data is NOT included to save bandwidth. Only files from the CURRENT message have their actual data included.';
    if (memories.length > 0) {
      systemInstruction += '\n\nImportant information to remember:\n';
      memories.forEach((memory, index) => {
        systemInstruction += `${index + 1}. ${memory.content}\n`;
      });
    }
    systemInstruction += '\n\nYou must respond with a JSON object containing:';
    systemInstruction += '\n- "response": Your text response to the user';
    systemInstruction += '\n- "memories": { "stores": ["memory description 1", ...], "forgets": ["memory ID 1", ...] } - Store or forget memories based on the conversation. To forget ALL memories, use "forgets": ["all"]';
    systemInstruction += '\n- "staging": { "shouldStage": true/false, "roomType": "Living room"|"Bedroom"|"Kitchen"|"Bathroom"|"Dining room"|"Office"|"Other", "additionalPrompt": "detailed staging description", "removeFurniture": true/false, "usePreviousImage": false|0|1|2|..., "furnitureImageIndex": null|0|1|2|... } OR "staging": [ { "shouldStage": true, ... }, { "shouldStage": true, ... }, ... ] - Request staging if the user wants to stage/modify a room image (ONLY use staging when the user has uploaded or is referring to an existing room image to modify). If the user wants to add a specific piece of furniture from a previous message, set "furnitureImageIndex" to the index of that furniture image (0 = most recent image, 1 = second most recent, etc.). You can provide MULTIPLE staging requests (up to 3) in an array if the user asks for multiple variations (e.g., "stage this room in 3 different themes"). Each staging request in the array will be processed separately.';
    systemInstruction += '\n- "imageRequest": { "requestImage": true/false, "imageIndex": 0|1|2|... } - Request to view/analyze a previous image by index (0 = most recent, 1 = second most recent, etc.). Use this when the user asks to "show me", "see", "view", or "display" a previous image. The image will be displayed to the user. If the user also wants analysis/description, the system will analyze it automatically.';
    systemInstruction += '\n- "generate": { "shouldGenerate": true/false, "prompt": "detailed image generation prompt" } OR "generate": [ { "shouldGenerate": true, "prompt": "..." }, { "shouldGenerate": true, "prompt": "..." }, ... ] - Generate a completely new image from text description (ONLY use generation when the user wants to create a NEW image from scratch, NOT when they want to modify an existing room image. If they uploaded an image or are referring to a previous image, use staging instead). You can provide MULTIPLE generation requests (up to 3) in an array if the user asks for multiple variations. Each generation request in the array will be processed separately.';
    systemInstruction += '\n\nIMPORTANT DISTINCTION:\n- Use "staging" when: user uploaded a room photo (3D perspective view of an interior space), user refers to a previous room photo with "CAD: False", user wants to modify/redesign an existing room photo that is NOT a CAD-staged image\n- Use "cad" (CAD-staging) when: (1) user uploaded a blueprint/floor plan (2D top-down architectural drawing), (2) user refers to a previous blueprint, (3) user says "stage" but the image is a blueprint/floor plan, OR (4) user wants to modify an image that has "CAD: True" in the image context - ALWAYS use CAD-staging for blueprints and CAD-staged images, even if the user says "stage"\n- Use "generate" when: user wants to create a completely new image from text only (no existing image involved), user asks to "generate", "create", "draw", or "make" an image of something that is NOT a room modification';
    systemInstruction += '\n\nSTAGING RULES (for room photos only):';
    systemInstruction += '\n- CRITICAL: Regular staging is ONLY for room photos (3D perspective interior views). If the user uploads or refers to a blueprint/floor plan (2D top-down architectural drawing), use CAD-staging ("cad" field) instead, even if they say "stage".';
    systemInstruction += '\n- CRITICAL: Before using regular staging, check the image context above. If the image you are modifying has "CAD: True" in its annotation, you MUST use CAD-staging ("cad" field) instead, NOT regular staging. This includes images you previously created with CAD-staging - if a user asks to modify a CAD-staged image, use CAD-staging again.';
    systemInstruction += '\n- Set "shouldStage": true if the user wants to stage a room photo, modify a room photo, change colors/walls/furniture, or apply any visual changes to a room photo (NOT a blueprint, and NOT a CAD-staged image with CAD: True)';
    systemInstruction += '\n- Set "usePreviousImage": false if using the current message\'s image, or the index (0 = most recent, 1 = second most recent, etc.) if modifying a previous image';
    systemInstruction += '\n- IMPORTANT: When adding furniture to a staged room, set "usePreviousImage" to the index of the STAGED room image (not the furniture image). Set "furnitureImageIndex" to the index of the furniture image. Look at the image context above to find the correct indices.';
    systemInstruction += '\n- The "additionalPrompt" should be a detailed, comprehensive description of the staging request';
    systemInstruction += '\n- If "shouldStage" is false, you can omit the "staging" field or set it to null';
    systemInstruction += '\n\nIMAGE REQUEST RULES:';
    systemInstruction += '\n- Set "requestImage": true if the user asks to see, describe, analyze, or look at a previous image';
    systemInstruction += '\n- Set "imageIndex" to the index of the image (0 = most recent, 1 = second most recent, etc.)';
    systemInstruction += '\n- If user says "original image", "first image", or "initial image", use the original image index shown above';
    systemInstruction += '\n- If "requestImage" is false, you can omit the "imageRequest" field or set it to null';
    systemInstruction += '\n\nRECALL RULES:';
    systemInstruction += '\n- "recall": { "shouldRecall": true/false, "imageIndex": 0|1|2|... } - Recall and display a previous image by index (0 = most recent, 1 = second most recent, etc.). Use this when the user asks to "see", "show", "recall", or "bring back" an old image. This works for ANY image in the conversation history: user-uploaded images, staged images, generated images, and CAD-staging renders. This is simpler than imageRequest - it just retrieves and displays the image without analysis. If user says "original image", "first image", or "initial image", use the original image index shown above.';
    systemInstruction += '\n- Set "shouldRecall": true if the user asks to see, show, recall, or bring back an old image';
    systemInstruction += '\n- You can recall ANY image from the conversation: user-uploaded images, images you staged, images you generated, or CAD-staging renders you created';
    systemInstruction += '\n- Set "imageIndex" to the index of the image (0 = most recent, 1 = second most recent, etc.)';
    systemInstruction += '\n- Check the "Available images in conversation history" list above to find the correct index for any image (including your own generated/staged images)';
    systemInstruction += '\n- If user says "original image", "first image", or "initial image", use the original image index shown above';
    systemInstruction += '\n- If user asks to see "the image I generated" or "the staged image", look for "generated image" or "staged image" in the image list above';
    systemInstruction += '\n- If "shouldRecall" is false, you can omit the "recall" field or set it to null';
    systemInstruction += '\n\nCAD-STAGING RULES (for blueprints/floor plans and CAD-staged images):';
    systemInstruction += '\n- "cad": { "shouldProcessCAD": true/false, "imageIndex": 0|1|2|..., "furnitureImageIndex": null|0|1|2|...|[...], "additionalPrompt": "detailed CAD-staging description" } OR "cad": [ { "shouldProcessCAD": true, ... }, { "shouldProcessCAD": true, ... }, ... ] - CAD-staging processes a top-down blueprint/floor plan image to create a 3D render. This is DIFFERENT from regular staging. Use CAD-staging when: (1) the user uploads a top-down blueprint, floor plan, or architectural drawing (2D plan view from above), OR (2) the user wants to modify an image that has "CAD: True" in its annotation (check the image context above). CRITICAL: Even if the user says "stage this blueprint" or "stage this floor plan", you MUST use CAD-staging (set "shouldProcessCAD": true), NOT regular staging. CRITICAL: If the user asks to modify a previously CAD-staged image (one with "CAD: True" in the image context), you MUST use CAD-staging again, NOT regular staging. Regular staging is ONLY for room photos (3D perspective views), NOT for blueprints or CAD-staged images. Set "imageIndex" to the index of the blueprint or CAD-staged image (0 = most recent, 1 = second most recent, etc.). If the user uploads a blueprint in the current message, use imageIndex 0. If the user wants to include specific furniture pieces in the 3D render, set "furnitureImageIndex" to the index (or array of indices) of the furniture image(s) from previous messages. The "additionalPrompt" should be a detailed description of any specific requirements, themes, styles, or preferences the user has (e.g., "medieval theme", "modern minimalist", "cozy atmosphere", etc.). The CAD-staging function will convert the blueprint to a top-down 3D render and include the furniture and styling preferences if specified. You can provide MULTIPLE CAD requests (up to 3) in an array if the user asks for multiple variations (e.g., "stage this blueprint in 3 different themes"). Each CAD request in the array will be processed separately.';
    systemInstruction += '\n- CRITICAL: If the user uploads or refers to a blueprint/floor plan (2D top-down architectural drawing), you MUST set "shouldProcessCAD": true, even if they say "stage". Blueprints ALWAYS use CAD-staging, never regular staging.';
    systemInstruction += '\n- CRITICAL: If the user asks to modify an image that has "CAD: True" in the image context above, you MUST use CAD-staging ("cad" field), NOT regular staging. Always check the CAD classification in the image annotations before deciding which pipeline to use.';
    systemInstruction += '\n- CRITICAL: Regular staging ("staging" field) is ONLY for room photos (3D perspective interior views). If you see a blueprint/floor plan OR an image with "CAD: True", use CAD-staging instead.';
    systemInstruction += '\n- Set "furnitureImageIndex" to the index (or array of indices) of furniture images from previous messages if the user wants to include specific furniture in the 3D render';
    systemInstruction += '\n- If "shouldProcessCAD" is false, you can omit the "cad" field or set it to null';

    const { message = '', conversationHistory: conversationHistoryStr, model } = req.body;
    const files = Array.isArray(req.files) ? req.files : [req.files];
    
    // Get model from request or default to gpt-4o-mini
    const selectedModel = model || 'gpt-4o-mini';
    
    // Parse conversation history if provided
    let conversationHistory = [];
    if (conversationHistoryStr) {
      try {
        conversationHistory = typeof conversationHistoryStr === 'string' 
          ? JSON.parse(conversationHistoryStr) 
          : conversationHistoryStr;
      } catch (error) {
        console.error('Error parsing conversation history:', error);
        conversationHistory = [];
      }
    }
    
    // Deduplicate conversation history to prevent double counting
    const originalHistoryLength = conversationHistory.length;
    conversationHistory = deduplicateMessages(conversationHistory);
    if (conversationHistory.length !== originalHistoryLength) {
      const removedCount = originalHistoryLength - conversationHistory.length;
      console.log(`[Deduplication] Removed ${removedCount} duplicate message(s) from conversation history (${originalHistoryLength} -> ${conversationHistory.length})`);
      if (DEBUG_MODE) {
        // Log which messages were duplicates
        const seenKeys = new Set();
        const original = conversationHistory.length < originalHistoryLength ? 
          JSON.parse(conversationHistoryStr || '[]') : conversationHistory;
        original.forEach((msg, idx) => {
          const key = Array.isArray(msg.content) 
            ? `${msg.role}:${JSON.stringify(msg.content.map(item => item.type === 'text' ? item.text : item.type))}`
            : `${msg.role}:${typeof msg.content === 'string' ? msg.content.trim() : 'non-string'}`;
          if (seenKeys.has(key)) {
            console.log(`[Deduplication] Duplicate found at index ${idx}: ${msg.role} message`);
          } else {
            seenKeys.add(key);
          }
        });
      }
    }
    
    // Check message limit (20 user messages max)
    const userMessageCount = conversationHistory.filter(msg => msg.role === 'user').length;
    if (userMessageCount >= 20) {
      return res.json({
        response: "You've reached the maximum conversation context limit (20 messages). Please reload the chat by clicking the reload button (↻) to the left of the file upload button to start a fresh conversation.",
        contextLimitReached: true
      });
    }
    
    // Build context about available images in history with annotations (now that conversationHistory is parsed)
    const { imageContext, imagesSentToGPT, originalImageIndex } = buildImageContext(conversationHistory);
    
    // Log image context for debugging
    if (imageContext) {
      console.log('=== IMAGE CONTEXT SENT TO AI (CHAT-UPLOAD) ===');
      console.log(imageContext);
      console.log('===============================================');
    } else {
      console.log('[Image Context] No images in conversation history');
    }
    
    if (imageContext) {
      systemInstruction += imageContext;
    }

    // Build user message content array
    const userContent = [];
    
    // Add text message if provided
    if (message && message.trim()) {
      userContent.push({ type: 'text', text: message });
    }
    
    // Define supported file types
    const supportedImageTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
    const supportedTypes = [
      ...supportedImageTypes,
      'application/pdf',
      'text/plain', 'text/markdown',
      'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ];
    
    // Process all files and check for unsupported types
    const fileInfo = [];
    let hasImages = false;
    let firstImageFile = null;
    const unsupportedFiles = [];
    
    for (const file of files) {
      fileInfo.push({ name: file.originalname, type: file.mimetype });
      
      // Check file extension first
      const ext = path.extname(file.originalname).toLowerCase();
      
      // Explicitly check for AVIF and other unsupported formats FIRST
      const isAVIF = ext === '.avif' || file.mimetype === 'image/avif' || file.mimetype === 'image/avif-sequence';
      
      if (isAVIF) {
        unsupportedFiles.push({ name: file.originalname, type: file.mimetype, ext: ext, fileType: 'AVIF' });
        // Add to userContent as text so AI can acknowledge it, but DON'T send the image to OpenAI
        if (userContent.length === 0 || userContent[userContent.length - 1].type !== 'text') {
          userContent.push({ type: 'text', text: '' });
        }
        const lastTextIndex = userContent.length - 1;
        userContent[lastTextIndex].text += (userContent[lastTextIndex].text ? '\n\n' : '') + 
          `I uploaded a file named "${file.originalname}" but it is in AVIF format which is not supported.`;
        continue; // Skip this file - don't process it
      }
      
      // Check if file type is supported (for non-AVIF files)
      const isSupported = supportedTypes.includes(file.mimetype) || 
                         (ext === '.jpg' || ext === '.jpeg') ||
                         (file.mimetype.startsWith('image/') && supportedImageTypes.some(t => file.mimetype.includes(t.split('/')[1])));
      
      if (!isSupported) {
        const fileType = ext.toUpperCase().substring(1) || file.mimetype;
        unsupportedFiles.push({ name: file.originalname, type: file.mimetype, ext: ext, fileType: fileType });
        // Add to userContent as text so AI can acknowledge it, but DON'T send unsupported files to OpenAI
        if (userContent.length === 0 || userContent[userContent.length - 1].type !== 'text') {
          userContent.push({ type: 'text', text: '' });
        }
        const lastTextIndex = userContent.length - 1;
        userContent[lastTextIndex].text += (userContent[lastTextIndex].text ? '\n\n' : '') + 
          `I uploaded a file named "${file.originalname}" but it is in ${fileType} format which is not supported.`;
        continue; // Skip this file - don't process it
      }
      
      // Only process supported files - double check it's not AVIF
      const isStillAVIF = ext === '.avif' || file.mimetype === 'image/avif' || file.mimetype === 'image/avif-sequence';
      if (isStillAVIF) {
        // Safety check - if AVIF somehow got here, skip it
        unsupportedFiles.push({ name: file.originalname, type: file.mimetype, ext: ext, fileType: 'AVIF' });
        if (userContent.length === 0 || userContent[userContent.length - 1].type !== 'text') {
          userContent.push({ type: 'text', text: '' });
        }
        const lastTextIndex = userContent.length - 1;
        userContent[lastTextIndex].text += (userContent[lastTextIndex].text ? '\n\n' : '') + 
          `I uploaded a file named "${file.originalname}" but it is in AVIF format which is not supported.`;
        continue;
      }
      
      if (file.mimetype.startsWith('image/') && supportedImageTypes.includes(file.mimetype)) {
        hasImages = true;
        if (!firstImageFile) {
          firstImageFile = file;
        }
        // For images, use vision API - only for supported formats
        const imageData = file.buffer.toString('base64');
        const imageDataUrl = `data:${file.mimetype};base64,${imageData}`;
        
        // Annotate image in parallel (don't await - let it run in background)
        const annotationPromise = annotateImage(imageDataUrl, false, true).then(annotation => {
          console.log(`[Image Annotation] Annotation for ${file.originalname}: ${annotation || 'failed'}`);
          return annotation;
        }).catch(err => {
          console.error(`[Image Annotation] Error annotating ${file.originalname}:`, err);
          return null;
        });
        
        userContent.push({
          type: 'image_url',
          image_url: {
            url: imageDataUrl
          },
          filename: file.originalname, // Store filename for later reference
          originalname: file.originalname,
          annotationPromise: annotationPromise // Store promise so we can await it later
        });
      } else {
        // For text/PDF files, include content in the message
        let fileContent = '';
        if (file.mimetype.startsWith('text/')) {
          fileContent = file.buffer.toString('utf8');
        } else {
          // For PDFs and other binary files, we can't directly process them
          fileContent = `[File: ${file.originalname}, Type: ${file.mimetype} - Content cannot be directly read]`;
        }
        
        // Add file content as text
        if (userContent.length === 0 || userContent[userContent.length - 1].type !== 'text') {
          userContent.push({ type: 'text', text: '' });
        }
        const lastTextIndex = userContent.length - 1;
        userContent[lastTextIndex].text += (userContent[lastTextIndex].text ? '\n\n' : '') + 
          `File: ${file.originalname}\n${fileContent}`;
      }
    }
    
    // If there are unsupported files, ensure the AI acknowledges them
    if (unsupportedFiles.length > 0) {
      // The unsupported files are already mentioned in userContent, but make sure there's a clear message
      if (!message || !message.trim()) {
        // If no user message, add a prompt for the AI to acknowledge unsupported files
        const unsupportedText = unsupportedFiles.map(f => {
          const fileType = f.fileType || (f.ext ? f.ext.toUpperCase().substring(1) : f.type);
          return `"${f.name}" (${fileType} format)`;
        }).join(' and ');
        
        if (userContent.length === 0 || (userContent.length === 1 && userContent[0].type === 'text' && !userContent[0].text.trim())) {
          userContent.unshift({ type: 'text', text: `I uploaded ${unsupportedFiles.length > 1 ? 'some files' : 'a file'} but ${unsupportedFiles.length > 1 ? 'they are' : 'it is'} in an unsupported format.` });
        }
      }
    } else if (userContent.length === 0 || (userContent.length === 1 && userContent[0].type === 'text' && !userContent[0].text)) {
      // Only add default message if no unsupported files and no content
      userContent.unshift({ type: 'text', text: 'Please analyze these files.' });
    }
    
    // MIDDLEMAN CHECK: Filter unsupported files from userContent before sending to OpenAI
    const { filteredContent: filteredUserContent, unsupportedFiles: detectedUnsupported } = filterUnsupportedFiles(userContent, files);
    
    // Also filter conversation history to ensure no unsupported files slip through
    const filteredConversationHistory = filterConversationHistory(conversationHistory);
    
    // Strip images from conversation history (except current message) to prevent payload size issues
    const strippedHistory = stripImagesFromHistory(filteredConversationHistory, false);
    
    // Update messages array with filtered conversation history (images stripped)
    const safeMessages = [
      { role: 'system', content: systemInstruction },
      ...strippedHistory.map(msg => {
        // All messages in history are text-only (images stripped)
        return {
          role: msg.role === 'user' ? 'user' : 'assistant',
          content: msg.content
        };
      })
    ];
    
    // Wait for image annotations and type detection to complete and store them
    const cleanedUserContent = await Promise.all(filteredUserContent.map(async (item) => {
      if (item.type === 'image_url' && item.image_url && item.image_url.url) {
        // Wait for annotation if it's still in progress
        let annotation = null;
        if (item.annotationPromise) {
          annotation = await item.annotationPromise;
        }
        
        // Downscale image if needed before sending to GPT
        const downscaledUrl = await downscaleImageForGPT(item.image_url.url);
        
        // Store annotation separately (not in the OpenAI payload)
        // OpenAI only accepts: { type: 'image_url', image_url: { url: '...' } }
        const imageItem = {
          type: 'image_url',
          image_url: {
            url: downscaledUrl
          }
        };
        
        // Store annotation separately for later use (not sent to OpenAI)
        imageItem._annotation = annotation;
        imageItem._filename = item.filename || item.originalname;
        
        return imageItem;
      }
      return item;
    }));
    
    // Clean content for OpenAI - create completely fresh objects with ONLY the properties OpenAI expects
    const openaiContent = cleanedUserContent.map(item => {
      if (item.type === 'image_url') {
        // OpenAI only accepts: { type: 'image_url', image_url: { url: '...' } }
        // Create a completely new object with ONLY these properties
        return {
          type: 'image_url',
          image_url: {
            url: item.image_url.url
          }
        };
      } else if (item.type === 'text') {
        // For text items, only include type and text
        return {
          type: 'text',
          text: item.text
        };
      }
      // For any other types, return as-is
      return item;
    });
    
    // Add the current user message with cleaned content (images included, annotations removed)
    safeMessages.push({
      role: 'user',
      content: openaiContent
    });

    // Use OpenAI GPT with vision support for images
    // Model is already set from req.body above
    
    // Debug logging - log what's being sent to AI (ALWAYS log, not just in DEBUG_MODE)
    const messagesJson = JSON.stringify(safeMessages);
    const payloadSize = Buffer.byteLength(messagesJson, 'utf8');
    const payloadSizeKB = (payloadSize / 1024).toFixed(2);
    const payloadSizeMB = (payloadSize / (1024 * 1024)).toFixed(2);
    
    console.log('=== SENDING TO AI (CHAT-UPLOAD) ===');
    console.log('Payload size:', payloadSize, 'bytes (', payloadSizeKB, 'KB /', payloadSizeMB, 'MB)');
    console.log('Model:', selectedModel);
    console.log('Has images:', hasImages);
    console.log('Number of messages:', safeMessages.length);
    
    if (DEBUG_MODE) {
      // Log individual messages instead of full array
      console.log('--- MESSAGES ---');
      safeMessages.forEach((msg, index) => {
        if (msg.role === 'system') {
          console.log(`Message ${index + 1} [SYSTEM]:`, msg.content.substring(0, 500) + (msg.content.length > 500 ? '... [truncated]' : ''));
        } else if (msg.role === 'user') {
          if (Array.isArray(msg.content)) {
            const textItems = msg.content.filter(item => item.type === 'text');
            const imageItems = msg.content.filter(item => item.type === 'image_url');
            const textContent = textItems.map(item => item.text).join(' ');
            console.log(`Message ${index + 1} [USER]: Text: "${textContent.substring(0, 200)}${textContent.length > 200 ? '...' : ''}" | Images: ${imageItems.length}`);
          } else {
            console.log(`Message ${index + 1} [USER]:`, msg.content.substring(0, 200) + (msg.content.length > 200 ? '...' : ''));
          }
        } else if (msg.role === 'assistant') {
          if (Array.isArray(msg.content)) {
            const textItems = msg.content.filter(item => item.type === 'text');
            const textContent = textItems.map(item => item.text).join(' ');
            console.log(`Message ${index + 1} [ASSISTANT]:`, textContent.substring(0, 200) + (textContent.length > 200 ? '...' : ''));
          } else {
            console.log(`Message ${index + 1} [ASSISTANT]:`, msg.content.substring(0, 200) + (msg.content.length > 200 ? '...' : ''));
          }
        }
      });
      console.log('----------------');
    }
    
    // Log image data sizes if present
    safeMessages.forEach((msg, idx) => {
      if (msg.role === 'user' && Array.isArray(msg.content)) {
        msg.content.forEach((item, itemIdx) => {
          if (item.type === 'image_url' && item.image_url && item.image_url.url) {
            const imageDataSize = Buffer.byteLength(item.image_url.url, 'utf8');
            console.log(`Message ${idx}, Image ${itemIdx}: ${(imageDataSize / 1024).toFixed(2)} KB`);
          }
        });
      }
    });
    
    console.log('===================================');
    
    let text;
    let aiResponseJson = null;
    let memoryActionsFromAI = { stores: [], forgets: [] };
    let stagingRequestFromAI = null;
    let imageRequestFromAI = null;
    let recallRequestFromAI = null;
    let generateRequestFromAI = null;
    let cadRequestFromAI = null;
    
    try {
      console.log('Calling OpenAI API...');
      
      // Final safety check: ensure all image objects only have the expected structure
      const finalMessages = safeMessages.map(msg => {
        if (msg.role === 'user' && Array.isArray(msg.content)) {
          return {
            ...msg,
            content: msg.content.map(item => {
              if (item.type === 'image_url' && item.image_url) {
                // Strip any extra properties - only keep what OpenAI expects
                return {
                  type: 'image_url',
                  image_url: {
                    url: item.image_url.url
                  }
                };
              }
              return item;
            })
          };
        }
        return msg;
      });
      
      const completion = await openai.chat.completions.create({
        model: selectedModel,
        messages: finalMessages,
        temperature: getTemperatureForModel(selectedModel),
        response_format: { type: 'json_object' }
      });

      aiResponseJson = JSON.parse(completion.choices[0].message.content);
      text = aiResponseJson.response || completion.choices[0].message.content;
      memoryActionsFromAI = aiResponseJson.memories || { stores: [], forgets: [] };
      stagingRequestFromAI = aiResponseJson.staging || null;
      imageRequestFromAI = aiResponseJson.imageRequest || null;
      recallRequestFromAI = aiResponseJson.recall || null;
      generateRequestFromAI = aiResponseJson.generate || null;
      cadRequestFromAI = aiResponseJson.cad || null;
    } catch (openaiError) {
      // If OpenAI API fails (e.g., due to unsupported image format), let the AI respond about it
      console.error('OpenAI API error:', openaiError);
      
      // Check if error is related to image processing
      const errorMessage = openaiError.message || '';
      const errorCode = openaiError.code || '';
      const isImageFormatError = errorCode === 'invalid_image_format' || 
                                errorMessage.toLowerCase().includes('unsupported image') ||
                                errorMessage.toLowerCase().includes('invalid image format');
      
      if (isImageFormatError || unsupportedFiles.length > 0) {
        // Create a message for the AI to respond about unsupported files
        const errorUserContent = [];
        if (message && message.trim()) {
          errorUserContent.push({ type: 'text', text: message });
        }
        
        // Add information about unsupported files
        if (unsupportedFiles.length > 0) {
          unsupportedFiles.forEach(file => {
            const fileType = file.fileType || (file.ext === '.avif' ? 'AVIF' : (file.ext ? file.ext.toUpperCase().substring(1) : file.type));
            errorUserContent.push({ 
              type: 'text', 
              text: `I uploaded "${file.name}" but it is in ${fileType} format which is not supported.` 
            });
          });
        } else if (isImageFormatError) {
          // If we got an image format error but didn't catch it earlier, mention it
          errorUserContent.push({ 
            type: 'text', 
            text: 'I uploaded an image file but it appears to be in an unsupported format.' 
          });
        }
        
        if (errorUserContent.length === 0) {
          errorUserContent.push({ type: 'text', text: 'I uploaded a file but encountered an error processing it.' });
        }
        
        // Filter conversation history in error handler too to prevent unsupported files
        const filteredErrorHistory = filterConversationHistory(conversationHistory);
        const errorMessages = [
          { role: 'system', content: systemInstruction },
          ...filteredErrorHistory,
          { role: 'user', content: errorUserContent }
        ];
        
        const errorCompletion = await openai.chat.completions.create({
          model: selectedModel,
          messages: errorMessages,
          temperature: getTemperatureForModel(selectedModel),
          response_format: { type: 'json_object' }
        });
        
        aiResponseJson = JSON.parse(errorCompletion.choices[0].message.content);
        text = aiResponseJson.response || errorCompletion.choices[0].message.content;
        memoryActionsFromAI = aiResponseJson.memories || { stores: [], forgets: [] };
        stagingRequestFromAI = aiResponseJson.staging || null;
        imageRequestFromAI = aiResponseJson.imageRequest || null;
        recallRequestFromAI = aiResponseJson.recall || null;
        generateRequestFromAI = aiResponseJson.generate || null;
      } else {
        // Re-throw if it's not an image-related error
        throw openaiError;
      }
    }
    
    // Log chat to CSV file
    const ipAddress = req.ip || req.connection?.remoteAddress || 'unknown';
    const userAgent = req.get('user-agent') || 'unknown';
    logChatToFile(userId, message, text, files, ipAddress, userAgent);
    
    // Debug logging
    if (DEBUG_MODE) {
      console.log('=== AI CHAT-UPLOAD DEBUG ===');
      console.log('User ID:', userId);
      console.log('User message:', message);
      console.log('Files:', fileInfo.map(f => `${f.name} (${f.type})`).join(', '));
      console.log('AI response:', text);
      console.log('Memories loaded:', memories.length);
      if (memories.length > 0) {
        console.log('Memories:', memories.map(m => m.content).join(', '));
      }
      console.log('============================');
    }

    // Process memory actions from AI response
    const memoryActions = { stores: [], forgets: [] };
    if (message && memoryActionsFromAI) {
      console.log(`[Memory] Processing memory actions from AI response:`, memoryActionsFromAI);
      
      // Process forget actions first
      if (memoryActionsFromAI.forgets && memoryActionsFromAI.forgets.length > 0) {
        // Check if user wants to forget all memories
        if (memoryActionsFromAI.forgets.includes('all')) {
          const forgottenCount = memories.length;
          memories = [];
          memoryActions.forgets = ['all'];
          console.log(`Forgot ALL ${forgottenCount} memories for user ${userId}`);
        } else {
          // Process individual memory forgets
          for (const memoryId of memoryActionsFromAI.forgets) {
            const initialLength = memories.length;
            // Try exact ID match first
            memories = memories.filter(m => m.id !== memoryId);
            
            if (memories.length < initialLength) {
              memoryActions.forgets.push(memoryId);
              console.log(`Forgot memory with ID for user ${userId}:`, memoryId);
            } else {
              // Try to find by content match if ID didn't work
              const memoryToForget = memories.find(m => 
                m.content.toLowerCase().includes(memoryId.toLowerCase()) ||
                memoryId.toLowerCase().includes(m.content.toLowerCase()) ||
                m.id.includes(memoryId) ||
                memoryId.includes(m.id)
              );
              
              if (memoryToForget) {
                memories = memories.filter(m => m.id !== memoryToForget.id);
                memoryActions.forgets.push(memoryToForget.id);
                console.log(`Forgot memory for user ${userId}:`, memoryToForget.content);
              }
            }
          }
        }
      }
      
      // Process store actions
      if (memoryActionsFromAI.stores && memoryActionsFromAI.stores.length > 0) {
        for (const memoryContent of memoryActionsFromAI.stores) {
          if (memoryContent && memoryContent.trim()) {
            const newMemory = {
              id: Date.now().toString() + '_' + Math.random().toString(36).substr(2, 9),
              content: memoryContent.trim(),
              timestamp: new Date().toISOString(),
              userMessage: message.substring(0, 100) // Store first 100 chars for context
            };
            memories.push(newMemory);
            memoryActions.stores.push(newMemory.content);
            console.log(`Stored new memory for user ${userId}:`, newMemory.content);
          }
        }
      }
      
      // Save memories if any changes were made
      if (memoryActions.stores.length > 0 || memoryActions.forgets.length > 0) {
        saveMemories(userId, memories);
      }
    }

    // Process staging request(s) from AI response (supports single or array)
    let stagingResults = [];
    
    // Check if current message has an image
    const currentMessageHasImage = firstImageFile !== null;
    
    if (stagingRequestFromAI) {
      // Normalize to array (max 3)
      const stagingRequests = Array.isArray(stagingRequestFromAI)
        ? stagingRequestFromAI.slice(0, 3).filter(s => s.shouldStage)
        : (stagingRequestFromAI.shouldStage ? [stagingRequestFromAI] : []);
      
      if (stagingRequests.length > 0) {
        console.log(`[Staging] Processing ${stagingRequests.length} staging request(s) from AI`);
        
        for (let i = 0; i < stagingRequests.length; i++) {
          const stagingRequest = stagingRequests[i];
          console.log(`[Staging] Processing staging request ${i + 1}/${stagingRequests.length}:`, stagingRequest);
          
          // Build staging params from AI response
          let stagingParams = {
            roomType: stagingRequest.roomType || 'Other',
            furnitureStyle: 'custom', // Always use custom
            additionalPrompt: stagingRequest.additionalPrompt || '',
            removeFurniture: stagingRequest.removeFurniture || false,
            usePreviousImage: stagingRequest.usePreviousImage !== undefined ? stagingRequest.usePreviousImage : false,
            furnitureImageIndex: stagingRequest.furnitureImageIndex !== undefined && stagingRequest.furnitureImageIndex !== null ? stagingRequest.furnitureImageIndex : null
          };
          
          // Fallback: If user mentions "original", "first", or "initial" image but AI didn't set usePreviousImage correctly
          if (!currentMessageHasImage) {
            const messageLower = message.toLowerCase();
            const hasOriginalKeywords = messageLower.includes('original') || 
                                        messageLower.includes('first image') || 
                                        messageLower.includes('initial image') ||
                                        messageLower.includes('go back to') ||
                                        messageLower.includes('refer back to');
            
            if (hasOriginalKeywords && (stagingParams.usePreviousImage === false || stagingParams.usePreviousImage === null)) {
              // Find the original (first) user-uploaded image
              const originalImageIndex = getOriginalImageIndex(conversationHistory);
              if (originalImageIndex !== null) {
                console.log(`[Staging] Fallback: User mentioned "original" but AI didn't set usePreviousImage. Overriding to use original image at index ${originalImageIndex}`);
                stagingParams.usePreviousImage = originalImageIndex;
              } else {
                // If no original found, use most recent (index 0)
                console.log(`[Staging] Fallback: User mentioned "original" but no original image found. Using most recent image (index 0) as fallback`);
                stagingParams.usePreviousImage = 0;
              }
            }
          }
          
          if (stagingParams) {
            try {
            let imageBuffer = null;
            let imageSource = '';
            
            // Determine which image to use
            if (stagingParams.usePreviousImage !== false && stagingParams.usePreviousImage !== null) {
            // AI requested a previous image
            const imageIndex = typeof stagingParams.usePreviousImage === 'number' ? stagingParams.usePreviousImage : 0;
            
            // Use the AI's chosen image index (AI should use context to determine the correct image)
            // Debug: Log conversation history structure
            console.log(`[Staging] Looking for image at index ${imageIndex}`);
            console.log(`[Staging] Conversation history length: ${conversationHistory.length}`);
            if (DEBUG_MODE) {
              console.log(`[Staging] Conversation history structure:`, JSON.stringify(conversationHistory.map(msg => ({
                role: msg.role,
                hasContent: !!msg.content,
                contentType: Array.isArray(msg.content) ? 'array' : typeof msg.content,
                contentLength: Array.isArray(msg.content) ? msg.content.length : (typeof msg.content === 'string' ? msg.content.length : 0),
                hasImages: Array.isArray(msg.content) ? msg.content.some(item => item.type === 'image_url') : false
              })), null, 2));
            }
            
            const previousImage = getImageFromHistory(conversationHistory, imageIndex);
            
            if (previousImage && previousImage.url) {
              const base64Data = previousImage.url.split(',')[1];
              if (base64Data) {
                imageBuffer = Buffer.from(base64Data, 'base64');
                imageSource = previousImage.isStaged ? `staged image (index ${imageIndex})` : `user-uploaded image (index ${imageIndex})`;
                console.log(`[Staging] Using previous ${imageSource}`);
              } else {
                console.log(`[Staging] Previous image found but base64 data extraction failed`);
              }
            } else {
              console.log(`[Staging] Previous image at index ${imageIndex} not found`);
              // Fallback: try to use the most recent image (index 0) if requested index doesn't exist
              if (imageIndex > 0) {
                console.log(`[Staging] Attempting fallback to index 0`);
                const fallbackImage = getImageFromHistory(conversationHistory, 0);
                if (fallbackImage && fallbackImage.url) {
                  const base64Data = fallbackImage.url.split(',')[1];
                  if (base64Data) {
                    imageBuffer = Buffer.from(base64Data, 'base64');
                    imageSource = fallbackImage.isStaged ? `staged image (fallback to index 0)` : `user-uploaded image (fallback to index 0)`;
                    console.log(`[Staging] Using fallback ${imageSource}`);
                  }
                }
              }
            }
          } else if (firstImageFile) {
            // Use current message's image
            imageBuffer = firstImageFile.buffer;
            imageSource = 'current message';
            console.log(`[Staging] Using image from current message`);
          }
          
          // Retrieve furniture image if specified
          let furnitureImageBuffer = null;
          if (stagingParams.furnitureImageIndex !== null && stagingParams.furnitureImageIndex !== undefined) {
            const furnitureIndex = typeof stagingParams.furnitureImageIndex === 'number' ? stagingParams.furnitureImageIndex : null;
            if (furnitureIndex !== null) {
              console.log(`[Staging] Looking for furniture image at index ${furnitureIndex}`);
              const furnitureImage = getImageFromHistory(conversationHistory, furnitureIndex);
              
              if (furnitureImage && furnitureImage.url) {
                const base64Data = furnitureImage.url.split(',')[1];
                if (base64Data) {
                  furnitureImageBuffer = Buffer.from(base64Data, 'base64');
                  console.log(`[Staging] Found furniture image at index ${furnitureIndex}`);
                }
              } else {
                console.log(`[Staging] Furniture image at index ${furnitureIndex} not found`);
              }
            }
          }
          
            if (imageBuffer) {
              try {
                const geminiModel = getGeminiImageModel(selectedModel);
                const stagedImage = await processStaging(imageBuffer, stagingParams, req, furnitureImageBuffer, geminiModel);
                if (stagedImage) {
                  // Annotate staged image in parallel
                  const annotationPromise = annotateImage(stagedImage).then(annotation => {
                    console.log(`[Image Annotation] Annotation for staged image ${i + 1}: ${annotation || 'failed'}`);
                    return annotation;
                  }).catch(err => {
                    console.error(`[Image Annotation] Error annotating staged image ${i + 1}:`, err);
                    return null;
                  });
                  
                  stagingResults.push({
                    stagedImage: stagedImage,
                    params: stagingParams,
                    annotationPromise: annotationPromise
                  });
                  console.log(`[Staging] Successfully processed staging ${i + 1}/${stagingRequests.length} for user ${userId} from ${imageSource}${furnitureImageBuffer ? ' with furniture image' : ''}`);
                }
              } catch (stagingError) {
                console.error(`[Staging] Error processing staging ${i + 1}:`, stagingError);
                console.error(`[Staging] Error stack:`, stagingError.stack);
                // Continue with other staging requests if one fails
                if (stagingRequests.length === 1) {
                  text = (text || '') + '\n\nSorry, I encountered an error while staging the room. Please try again.';
                }
              }
            } else {
              console.log(`[Staging] No image found for staging ${i + 1}`);
              if (stagingRequests.length === 1) {
                text = (text || '') + '\n\nSorry, I couldn\'t find the image to stage. Please make sure you\'ve uploaded an image.';
              }
            }
          } catch (error) {
            console.error(`[Staging] Error in staging request ${i + 1}:`, error);
            console.error(`[Staging] Error stack:`, error.stack);
            // Continue with other staging requests if one fails
            if (stagingRequests.length === 1) {
              text = (text || '') + '\n\nSorry, I encountered an error while processing the staging request. Please try again.';
            }
          }
          }
        }
      }
    }

    // Process image generation request(s) from AI response (supports single or array)
    let generatedImages = [];
    
    if (generateRequestFromAI) {
      // Normalize to array (max 3)
      const generateRequests = Array.isArray(generateRequestFromAI) 
        ? generateRequestFromAI.slice(0, 3).filter(g => g.shouldGenerate && g.prompt)
        : (generateRequestFromAI.shouldGenerate && generateRequestFromAI.prompt ? [generateRequestFromAI] : []);
      
      if (generateRequests.length > 0) {
        console.log(`[Image Generation] Processing ${generateRequests.length} generation request(s) from AI`);
        
        for (let i = 0; i < generateRequests.length; i++) {
          const genRequest = generateRequests[i];
          try {
            console.log(`[Image Generation] Processing generation request ${i + 1}/${generateRequests.length}:`, genRequest.prompt.substring(0, 100) + '...');
            const geminiModel = getGeminiImageModel(selectedModel);
            const generatedImage = await processImageGeneration(genRequest.prompt, req, geminiModel);
            if (generatedImage) {
              // Annotate generated image in parallel
              const annotationPromise = annotateImage(generatedImage).then(annotation => {
                console.log(`[Image Annotation] Annotation for generated image ${i + 1}: ${annotation || 'failed'}`);
                return annotation;
              }).catch(err => {
                console.error(`[Image Annotation] Error annotating generated image ${i + 1}:`, err);
                return null;
              });
              
              generatedImages.push({
                image: generatedImage,
                annotationPromise: annotationPromise
              });
              console.log(`[Image Generation] Successfully generated image ${i + 1}/${generateRequests.length}`);
            }
          } catch (error) {
            console.error(`[Image Generation] Error generating image ${i + 1}:`, error);
            // Continue with other images if one fails
          }
        }
        
        if (generateRequests.length > 0 && generatedImages.length === 0) {
          text = text + '\n\nSorry, I encountered an error while generating the images. Please try again.';
        }
      }
    }

    // Process recall request from AI response (simpler than imageRequest - just retrieves and displays)
    let recalledImageForDisplay = null;
    if (recallRequestFromAI && recallRequestFromAI.shouldRecall) {
      try {
        const imageIndex = typeof recallRequestFromAI.imageIndex === 'number' ? recallRequestFromAI.imageIndex : 0;
        console.log(`[Recall] Processing recall request from AI, index: ${imageIndex}`);
        
        // Retrieve the image from conversation history
        const recalledImage = getImageFromHistory(conversationHistory, imageIndex);
        
        if (recalledImage && recalledImage.url) {
          console.log(`[Recall] Found image at index ${imageIndex}`);
          recalledImageForDisplay = recalledImage.url;
        } else {
          console.log(`[Recall] Image at index ${imageIndex} not found`);
        }
      } catch (error) {
        console.error('Error processing recall request:', error);
        // Continue with original response if recall fails
      }
    }

    // Process image request from AI response
    let requestedImageForDisplay = null;
    if (imageRequestFromAI && imageRequestFromAI.requestImage) {
      try {
        const imageIndex = typeof imageRequestFromAI.imageIndex === 'number' ? imageRequestFromAI.imageIndex : 0;
        console.log(`[Image Request] Processing image request from AI, index: ${imageIndex}`);
        
        // Retrieve the image from conversation history
        const requestedImage = getImageFromHistory(conversationHistory, imageIndex);
        
        if (requestedImage && requestedImage.url) {
          console.log(`[Image Request] Found image at index ${imageIndex}`);
          
          // Store the image URL to return in response for display
          requestedImageForDisplay = requestedImage.url;
          
          // Check if user wants to analyze/describe the image (vs just view it)
          // Only analyze if explicitly asking for description/analysis, not just "show me"
          const messageLower = (message || '').toLowerCase();
          const wantsAnalysis = (messageLower.includes('describe') && !messageLower.includes('show')) || 
                               (messageLower.includes('analyze') && !messageLower.includes('show')) || 
                               (messageLower.includes('what') && messageLower.includes('in') && !messageLower.includes('show')) ||
                               messageLower.includes('tell me about') ||
                               (messageLower.includes('explain') && !messageLower.includes('show'));
          
          if (wantsAnalysis) {
            console.log(`[Image Request] User wants analysis, sending to GPT`);
            // Build messages for image analysis (include conversation history context)
            const imageAnalysisMessages = [
              { role: 'system', content: systemInstruction },
              ...safeMessages.slice(1), // Skip the original system message, keep the rest
              {
                role: 'user',
                content: [
                  { type: 'text', text: message || 'Please analyze this image.' },
                  {
                    type: 'image_url',
                    image_url: {
                      url: await downscaleImageForGPT(requestedImage.url)
                    }
                  }
                ]
              }
            ];
            
            const imageAnalysisCompletion = await openai.chat.completions.create({
              model: selectedModel,
              messages: imageAnalysisMessages,
              temperature: getTemperatureForModel(selectedModel),
              response_format: { type: 'json_object' }
            });
            
            const imageAnalysisJson = JSON.parse(imageAnalysisCompletion.choices[0].message.content);
            text = imageAnalysisJson.response || imageAnalysisCompletion.choices[0].message.content;
            
            console.log(`[Image Request] Successfully analyzed image, response: ${text.substring(0, 100)}...`);
          } else {
            // User just wants to see the image - keep the original text response
            console.log(`[Image Request] User wants to view image, returning image for display`);
          }
        } else {
          console.log(`[Image Request] Image at index ${imageIndex} not found`);
        }
      } catch (error) {
        console.error('Error processing image request:', error);
        // Continue with original response if image request fails
      }
    }

    // Process CAD request(s) from AI response (supports single or array)
    let cadResultsUpload = [];
    
    if (cadRequestFromAI) {
      // Normalize to array (max 3)
      const cadRequests = Array.isArray(cadRequestFromAI)
        ? cadRequestFromAI.slice(0, 3).filter(c => c.shouldProcessCAD)
        : (cadRequestFromAI.shouldProcessCAD ? [cadRequestFromAI] : []);
      
      if (cadRequests.length > 0) {
        console.log(`[CAD] Processing ${cadRequests.length} CAD request(s) from AI`);
        
        for (let i = 0; i < cadRequests.length; i++) {
          const cadRequest = cadRequests[i];
          console.log(`[CAD] Processing CAD request ${i + 1}/${cadRequests.length}:`, cadRequest);
          
          try {
            const imageIndex = typeof cadRequest.imageIndex === 'number' ? cadRequest.imageIndex : 0;
            console.log(`[CAD] Processing CAD request from AI, index: ${imageIndex}`);
            
            // Retrieve the blueprint image from conversation history
            const blueprintImage = getImageFromHistory(conversationHistory, imageIndex);
            
            if (blueprintImage && blueprintImage.url) {
              console.log(`[CAD] Found blueprint image at index ${imageIndex}`);
              
              // Extract base64 data from the image URL
              const base64Data = blueprintImage.url.split(',')[1];
              if (base64Data) {
                const imageBuffer = Buffer.from(base64Data, 'base64');
                const mimeType = blueprintImage.url.match(/data:([^;]+)/)?.[1] || 'image/png';
                
                // Retrieve furniture images if specified
                const furnitureImages = [];
                if (cadRequest.furnitureImageIndex !== null && cadRequest.furnitureImageIndex !== undefined) {
                  const furnitureIndices = Array.isArray(cadRequest.furnitureImageIndex) 
                    ? cadRequest.furnitureImageIndex 
                    : [cadRequest.furnitureImageIndex];
                  
                  for (const furnitureIndex of furnitureIndices) {
                    if (furnitureIndex !== null && furnitureIndex !== undefined) {
                      const furnitureImage = getImageFromHistory(conversationHistory, furnitureIndex);
                      if (furnitureImage && furnitureImage.url) {
                        const furnitureBase64Data = furnitureImage.url.split(',')[1];
                        if (furnitureBase64Data) {
                          const furnitureBuffer = Buffer.from(furnitureBase64Data, 'base64');
                          const furnitureMimeType = furnitureImage.url.match(/data:([^;]+)/)?.[1] || 'image/png';
                          furnitureImages.push({
                            image: furnitureBuffer,
                            mimeType: furnitureMimeType
                          });
                          console.log(`[CAD] Found furniture image at index ${furnitureIndex}`);
                    }
                  } else {
                    console.log(`[CAD] Furniture image at index ${furnitureIndex} not found`);
                  }
                }
              }
            }
            
                console.log(`[CAD] Processing blueprint with CAD function${furnitureImages.length > 0 ? ` (with ${furnitureImages.length} furniture image(s))` : ''}${cadRequest.additionalPrompt ? ` (with additional prompt: ${cadRequest.additionalPrompt.substring(0, 50)}...)` : ''}...`);
                // Process the blueprint through CAD function
                const additionalPrompt = cadRequest.additionalPrompt || null;
                const cadResultBuffer = await blueprintTo3D(imageBuffer, mimeType, furnitureImages, additionalPrompt);
                
                // Convert result buffer to data URL
                const cadImageBase64 = cadResultBuffer.toString('base64');
                const cadImageForDisplay = `data:${mimeType};base64,${cadImageBase64}`;
                
                // Annotate CAD image in parallel
                const annotationPromise = annotateImage(cadImageForDisplay, true).then(annotation => {
                  console.log(`[Image Annotation] Annotation for CAD render ${i + 1}: ${annotation || 'failed'}`);
                  return annotation;
                }).catch(err => {
                  console.error(`[Image Annotation] Error annotating CAD render ${i + 1}:`, err);
                  return null;
                });
                
                cadResultsUpload.push({
                  cadImage: cadImageForDisplay,
                  params: cadRequest,
                  annotationPromise: annotationPromise
                });
                
                console.log(`[CAD] Successfully generated 3D render ${i + 1}/${cadRequests.length} from blueprint${furnitureImages.length > 0 ? ' with furniture' : ''}`);
              } else {
                console.log(`[CAD] Failed to extract base64 data from blueprint image`);
              }
            } else {
              console.log(`[CAD] Blueprint image at index ${imageIndex} not found`);
            }
          } catch (error) {
            console.error(`[CAD] Error processing CAD request ${i + 1}:`, error);
            // Continue with other CAD requests if one fails
            if (cadRequests.length === 1) {
              text = (text || '') + '\n\nSorry, I encountered an error while processing the CAD blueprint. Please try again.';
            }
          }
        }
      }
    }
    
    // Legacy support: maintain cadImageForDisplay and cadAnnotationPromiseUpload for backward compatibility
    let cadImageForDisplay = null;
    let cadAnnotationPromiseUpload = null;
    if (cadResultsUpload.length > 0) {
      cadImageForDisplay = cadResultsUpload[0].cadImage;
      cadAnnotationPromiseUpload = cadResultsUpload[0].annotationPromise;
    }

    // Wait for all annotations to complete before building response
    const stagedImageAnnotationsUpload = {};
    if (stagingResults.length > 0) {
      for (let i = 0; i < stagingResults.length; i++) {
        if (stagingResults[i].annotationPromise) {
          const annotation = await stagingResults[i].annotationPromise;
          if (annotation) {
            stagedImageAnnotationsUpload[`staged_${i}`] = annotation;
          }
        }
      }
    }
    
    const generatedImageAnnotationsUpload = {};
    if (generatedImages.length > 0) {
      for (let i = 0; i < generatedImages.length; i++) {
        if (generatedImages[i].annotationPromise) {
          const annotation = await generatedImages[i].annotationPromise;
          if (annotation) {
            generatedImageAnnotationsUpload[`generated_${i}`] = annotation;
          }
        }
      }
    }
    
    // Wait for all CAD annotations to complete
    const cadImageAnnotationsUpload = {};
    if (cadResultsUpload.length > 0) {
      for (let i = 0; i < cadResultsUpload.length; i++) {
        if (cadResultsUpload[i].annotationPromise) {
          const annotation = await cadResultsUpload[i].annotationPromise;
          if (annotation) {
            cadImageAnnotationsUpload[`cad_${i}`] = annotation;
          }
        }
      }
    }
    
    // Legacy support
    let cadImageAnnotationUpload = null;
    if (cadImageForDisplay && cadAnnotationPromiseUpload) {
      cadImageAnnotationUpload = await cadAnnotationPromiseUpload;
    }

    // Extract image annotations from cleanedUserContent to return to frontend
    // Note: We use _annotation (private property) which is not sent to OpenAI
    const imageAnnotations = {};
    cleanedUserContent.forEach((item, idx) => {
      if (item.type === 'image_url' && item._annotation) {
        const filename = item._filename || (filteredUserContent[idx] && (filteredUserContent[idx].filename || filteredUserContent[idx].originalname));
        if (filename) {
          imageAnnotations[filename] = item._annotation;
        }
      }
    });
    
    // Return JSON response with text, memory actions, staging result(s), generated image(s), requested image, recalled image, and annotations if available
    const response = { 
      response: text,
      files: fileInfo,
      memories: memoryActions
    };
    
    // Handle multiple staging results
    if (stagingResults.length > 0) {
      if (stagingResults.length === 1) {
        // Single result - maintain backward compatibility
        response.stagedImage = stagingResults[0].stagedImage;
        response.stagingParams = stagingResults[0].params;
      } else {
        // Multiple results - return as array
        response.stagedImages = stagingResults.map(r => r.stagedImage);
        response.stagingParams = stagingResults.map(r => r.params);
      }
      // Include annotations if available
      if (Object.keys(stagedImageAnnotationsUpload).length > 0) {
        response.stagedImageAnnotations = stagedImageAnnotationsUpload;
      }
    }
    
    // Handle multiple generated images
    if (generatedImages.length > 0) {
      if (generatedImages.length === 1) {
        // Single result - maintain backward compatibility
        response.generatedImage = generatedImages[0].image || generatedImages[0];
      } else {
        // Multiple results - return as array
        response.generatedImages = generatedImages.map(g => g.image || g);
      }
      // Include annotations if available
      if (Object.keys(generatedImageAnnotationsUpload).length > 0) {
        response.generatedImageAnnotations = generatedImageAnnotationsUpload;
      }
    }
    
    if (requestedImageForDisplay) {
      response.requestedImage = requestedImageForDisplay;
    }
    
    if (recalledImageForDisplay) {
      response.recalledImage = recalledImageForDisplay;
    }
    
    // Handle multiple CAD results
    if (cadResultsUpload.length > 0) {
      if (cadResultsUpload.length === 1) {
        // Single result - maintain backward compatibility
        response.cadImage = cadResultsUpload[0].cadImage;
        if (cadImageAnnotationUpload) {
          response.cadImageAnnotation = cadImageAnnotationUpload;
        }
      } else {
        // Multiple results - return as array
        response.cadImages = cadResultsUpload.map(r => r.cadImage);
        response.cadParams = cadResultsUpload.map(r => r.params);
      }
      // Include annotations if available
      if (Object.keys(cadImageAnnotationsUpload).length > 0) {
        response.cadImageAnnotations = cadImageAnnotationsUpload;
      }
    }
    
    if (Object.keys(imageAnnotations).length > 0) {
      response.imageAnnotations = imageAnnotations;
    }
    
    res.json(response);
  } catch (error) {
    console.error('[Chat Upload] Fatal error in chat-upload endpoint:', error);
    console.error('[Chat Upload] Error stack:', error.stack);
    
    // Try to have the AI respond about the error, especially for unsupported file types
    try {
      const errorMessage = error.message || '';
      const isFileTypeError = errorMessage.toLowerCase().includes('image') || 
                             errorMessage.toLowerCase().includes('format') || 
                             errorMessage.toLowerCase().includes('avif') ||
                             errorMessage.toLowerCase().includes('unsupported');
      
      // Check if we have files in the request
      const files = req.files ? (Array.isArray(req.files) ? req.files : [req.files]) : [];
      
      if ((isFileTypeError || files.length > 0) && openai) {
        // Find unsupported files by checking extensions and MIME types
        const unsupportedFiles = files.filter(file => {
          const ext = path.extname(file.originalname).toLowerCase();
          const supportedImageTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
          return ext === '.avif' || 
                 file.mimetype === 'image/avif' ||
                 (file.mimetype.startsWith('image/') && !supportedImageTypes.includes(file.mimetype));
        });
        
        if (unsupportedFiles.length > 0) {
          const fileTypes = unsupportedFiles.map(file => {
            const ext = path.extname(file.originalname).toLowerCase();
            if (ext === '.avif' || file.mimetype === 'image/avif') {
              return 'AVIF';
            }
            return ext.toUpperCase().substring(1) || file.mimetype;
          });
          
          const uniqueFileTypes = [...new Set(fileTypes)];
          const fileTypeList = uniqueFileTypes.length === 1 
            ? uniqueFileTypes[0] 
            : uniqueFileTypes.join(', ');
          
          const aiResponse = `I'm unable to handle ${uniqueFileTypes.length > 1 ? 'these file types' : 'this file type'}: ${fileTypeList}. ` +
                           `Supported file types are: images (JPEG, JPG, PNG, WebP, GIF), PDFs, and text files. ` +
                           `Please convert ${unsupportedFiles.length > 1 ? 'these files' : 'this file'} to a supported format and try again.`;
          
          return res.json({ 
            response: aiResponse,
            files: unsupportedFiles.map(f => ({ name: f.originalname, type: f.mimetype })),
            memories: { stores: [], forgets: [] }
          });
        }
      }
    } catch (aiError) {
      console.error('Error generating AI error response:', aiError);
    }
    
    // Fallback to generic error - always send a response to prevent hanging requests
    if (!res.headersSent) {
      res.status(500).json({ 
        error: 'File processing failed', 
        details: 'An unexpected error occurred. Please try again.',
        response: 'I apologize, but I encountered an unexpected error processing your files. Please try again.'
      });
    }
  }
});

// Contact logs endpoint - serves the contact logs CSV file (protected)
app.get('/contactlogs', protectLogs, (req, res) => {
  try {
    let logDir;
    
    if (process.env.RENDER && fs.existsSync('/data')) {
      // Use Render's mounted disk
      logDir = '/data';
    } else {
      // Use project data folder for local development
      logDir = path.join(__dirname, 'data');
    }

    const logFile = path.join(logDir, 'contact_logs.csv');
    
    if (fs.existsSync(logFile)) {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'inline; filename="contact_logs.csv"');
      res.sendFile(logFile);
    } else {
      res.status(404).json({ 
        error: 'Log file not found',
        message: 'No contact logs are available yet'
      });
    }
  } catch (error) {
    console.error('Error serving contact log file:', error);
    res.status(500).json({ 
      error: 'Failed to retrieve contact logs',
      message: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`AI configured: ${!!genAI}`);
  

  const fakeContactAdd = 135;
  const fakePromptAdd = 1030;
  // Initialize prompt count on server startup
  initializePromptCount();
  promptCount += fakePromptAdd;
  // Initialize contact count on server startup
  initializeContactCount();
  contactCount += fakeContactAdd;
});
