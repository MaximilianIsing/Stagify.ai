import express from 'express';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs';
import { GoogleGenerativeAI } from "@google/generative-ai";
import sharp from "sharp";
import cors from 'cors';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Function to log prompts to file
function logPromptToFile(promptText, roomType, furnitureStyle, additionalPrompt, removeFurniture) {
  console.log('🚀 logPromptToFile function started');
  try {
    const timestamp = new Date().toISOString();
    const logEntry = JSON.stringify({
      timestamp: timestamp,
      roomType: roomType,
      furnitureStyle: furnitureStyle,
      additionalPrompt: additionalPrompt || '',
      removeFurniture: removeFurniture
    }) + '\n';
    
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
    
    console.log('Using log directory:', logDir);
    
    const logFile = path.join(logDir, 'prompt_logs.txt');
    console.log('Full log file path:', logFile);
    
    // Use async version with callback to ensure it completes
    fs.appendFile(logFile, logEntry, (err) => {
      if (err) {
        console.error('Error writing to prompt log:', err);
      }
    });
  } catch (error) {
    console.error('Error in logPromptToFile:', error);
  }
}

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 100 * 1024 * 1024, // 50MB limit
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

// Initialize Google AI
let genAI;
try {
  // Try environment variable first (Render), then fall back to local file
  let apiKey = process.env.GOOGLE_AI_API_KEY;
  if (apiKey === undefined){
    console.log('GOOGLE_AI_API_KEY is not set, using local file');
    apiKey = fs.readFileSync(path.join(__dirname, 'key.txt'), 'utf8').trim();
  }
  console.log("API key Asuccessfully loaded");
  genAI = new GoogleGenerativeAI(apiKey);
} catch (error) {
  console.error('Error initializing Google AI:', error.message);
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

/**
 * Generate styling prompt based on user preferences
 */
function generatePrompt(roomType, furnitureStyle, additionalPrompt, removeFurniture = false) {
  const styleDescriptions = {
    standard: "Stage this room with stylish, contemporary furniture that appeals to a broad audience. Use neutral colors and clean lines.",
    modern: "Stage this room in a modern style by adding a low-profile sectional sofa in a neutral color such as gray, white, or black, a sleek glass or polished stone coffee table with minimalist lines, and an accent chair with a bold sculptural design. Incorporate a large area rug in a solid tone or subtle geometric pattern to ground the space, and add statement lighting such as a slim arc floor lamp or a contemporary pendant with metallic or matte finishes. Keep accessories minimal, using a few curated décor pieces like abstract sculptures, modern art prints, or monochrome vases. Emphasize clean lines, open space, and a neutral palette with occasional bold accents to create a refined, sophisticated atmosphere.",
    midcentury: "Stage this room with mid-century modern furniture featuring warm wood tones, tapered legs, and iconic silhouettes. Add vintage-inspired lighting and geometric patterns.",
    scandinavian: "Stage this room in Scandinavian style with light wood furniture, neutral textiles, cozy textures, and minimalist décor. Emphasize functionality and hygge comfort.",
    luxury: "Stage this room with high-end luxury furniture featuring rich materials like marble, velvet, and gold accents. Create an opulent, sophisticated atmosphere.",
    coastal: "Stage this room with coastal-inspired furniture in light blues, whites, and natural textures. Add nautical elements and beach-inspired décor.",
    farmhouse: "Stage this room with rustic farmhouse furniture featuring reclaimed wood, vintage pieces, and cozy textiles in warm, earthy tones.",
    custom: "Stage this room with the furniture and decor the user asks for."
  };

  const roomSpecific = roomType === 'Bedroom' ? ' Focus on bedroom furniture like beds, nightstands, and dressers.' :
                     roomType === 'Living room' ? ' Focus on living room furniture like sofas, coffee tables, and entertainment centers.' :
                     roomType === 'Dining room' ? ' Focus on dining furniture like tables, chairs, and storage.' :
                     roomType === 'Kitchen' ? ' Focus on kitchen elements and dining areas.' :
                     roomType === 'Office' ? ' Focus on office furniture like desks, chairs, and storage.' :
                     roomType === 'Bathroom' ? ' Focus on bathroom elements like a toilet, sink, and shower. Ignore other elements like sofas or beds.' : ''; 

  let prompt = "";
  
  // Add furniture removal instruction if requested
  const furnitureRemovalText = removeFurniture ? "First, remove all existing furniture and decor from the room. Then, " : "Try not to remove existing furniture, if there is any.";
  
  if (roomType === 'Bathroom') {
    prompt = `${furnitureRemovalText}Stage this room as a bathroom. ${roomSpecific} In a ${roomType} space. Do not alter or remove any walls, windows, doors, or architectural features. Focus only on adding or arranging furniture and decor to professionally stage the room.`;
  } else {
    prompt = `${furnitureRemovalText}${styleDescriptions[furnitureStyle] || styleDescriptions.standard}${roomSpecific}. Do not alter or remove any walls, windows, doors, or architectural features. Focus only on adding or arranging furniture and decor to professionally stage the room.`;
  }
  // Add additional prompting if provided
  if (additionalPrompt && additionalPrompt.trim()) {
    prompt += ` ${additionalPrompt.trim()}`;
  }

  prompt += " Leave the rest of the room's architecture the same to highlight the furniture and design. Ensure the result looks realistic and professionally staged.";
  
  return prompt;
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

    const { roomType = 'Living room', furnitureStyle = 'standard', additionalPrompt = '', removeFurniture = false } = req.body;
    

    const processedImageBuffer = await downscaleImage(req.file.buffer);
    const base64Image = processedImageBuffer.toString("base64");

    // Generate prompt based on user preferences
    const promptText = generatePrompt(roomType, furnitureStyle, additionalPrompt, removeFurniture);
    
    // Log prompt to file instead of console
    console.log('🔥 About to call logPromptToFile...');
    logPromptToFile(promptText, roomType, furnitureStyle, additionalPrompt, removeFurniture);
    console.log('🔥 Called logPromptToFile');

    const prompt = [
      { text: promptText },
      {
        inlineData: {
          mimeType: "image/jpeg",
          data: base64Image, 
        },
      },
    ];

    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-image-preview" });
    const result = await model.generateContent(prompt);
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

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    aiConfigured: !!genAI
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`AI configured: ${!!genAI}`);
});
