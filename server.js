import express from 'express';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs';
import https from 'https';
import FormData from 'form-data';
import { GoogleGenerativeAI } from "@google/generative-ai";
import sharp from "sharp";
import cors from 'cors';
import { promptMatrix } from './promptMatrix.js';

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
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

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

// External PDF processing server URL
const PDF_PROCESSING_SERVER = 'https://stagify-project-imagination.onrender.com';

// Initialize Google AI
let genAI;
try {
  // Try environment variable first (Render), then fall back to local file
  let apiKey = process.env.GOOGLE_AI_API_KEY;
  if (apiKey === undefined){
    console.log('GOOGLE_AI_API_KEY is not set in an enviorment variable, using local file');
    apiKey = fs.readFileSync(path.join(__dirname, 'key.txt'), 'utf8').trim();
  }
  console.log("API key successfully loaded");
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
 * Generate styling prompt based on user preferences using a matrix system
 */
function generatePrompt(roomType, furnitureStyle, additionalPrompt, removeFurniture) {

  // Get the specific prompt for this room type and style combination
  const basePrompt = promptMatrix[roomType]?.[furnitureStyle] || promptMatrix[roomType]?.['standard'] || "Stage this room professionally.";
  
  // Add furniture removal instruction if requested
  removeFurniture = removeFurniture === 'true' ? true : false;
  const furnitureRemovalText = removeFurniture 
    ? "First, remove all existing furniture and decor from the room. Then, " 
    : "Try not to remove existing furniture, if there is any. ";
  
  // Build the complete prompt
  let prompt = `${furnitureRemovalText}${basePrompt} Do not alter or remove any walls, windows, doors, or architectural features. Focus only on adding or arranging furniture and decor to professionally stage the room. Leave the rest of the room's architecture the same to highlight the furniture and design. Ensure the result looks realistic and professionally staged. Ensure that no extra doors, windows, or walls are added.`;
  // Add additional prompting if provided
  if (additionalPrompt && additionalPrompt.trim()) {
    prompt += ` Pritoritize the following above everything else: ${additionalPrompt.trim()}`;
  };
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

    const { roomType = 'Living room', furnitureStyle = 'standard', additionalPrompt = '', removeFurniture = false, userRole = 'unknown', userReferralSource = 'unknown', userEmail = 'unknown' } = req.body;
    
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
