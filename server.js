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
  console.log('API key:', apiKey);
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
    
    console.log(`Original image dimensions: ${metadata.width}x${metadata.height}`);
    
    // Check if downscaling is needed
    if (metadata.width <= 1920 && metadata.height <= 1080) {
      console.log("Image is already within size limits, returning original...");
      return imageBuffer;
    }
    
    // Calculate the scaling factor to fit within 1920x1080 while maintaining aspect ratio
    const scaleWidth = 1920 / metadata.width;
    const scaleHeight = 1080 / metadata.height;
    const scale = Math.min(scaleWidth, scaleHeight);
    
    const newWidth = Math.floor(metadata.width * scale);
    const newHeight = Math.floor(metadata.height * scale);
    
    console.log(`Downscaling to: ${newWidth}x${newHeight} (scale factor: ${scale.toFixed(3)})`);
    
    const processedBuffer = await image
      .resize(newWidth, newHeight, {
        kernel: sharp.kernel.lanczos3,
        withoutEnlargement: true
      })
      .jpeg({ quality: 90 })
      .toBuffer();
      
    console.log(`Image successfully downscaled`);
    return processedBuffer;
  } catch (error) {
    console.error("Error downscaling image:", error);
    throw error;
  }
}

/**
 * Generate styling prompt based on user preferences
 */
function generatePrompt(roomType, furnitureStyle, additionalPrompt) {
  const styleDescriptions = {
    standard: "Stage this room with stylish, contemporary furniture that appeals to a broad audience. Use neutral colors and clean lines.",
    modern: "Stage this room in a modern style by adding a low-profile sectional sofa in a neutral color such as gray, white, or black, a sleek glass or polished stone coffee table with minimalist lines, and an accent chair with a bold sculptural design. Incorporate a large area rug in a solid tone or subtle geometric pattern to ground the space, and add statement lighting such as a slim arc floor lamp or a contemporary pendant with metallic or matte finishes. Keep accessories minimal, using a few curated décor pieces like abstract sculptures, modern art prints, or monochrome vases. Emphasize clean lines, open space, and a neutral palette with occasional bold accents to create a refined, sophisticated atmosphere.",
    midcentury: "Stage this room with mid-century modern furniture featuring warm wood tones, tapered legs, and iconic silhouettes. Add vintage-inspired lighting and geometric patterns.",
    scandinavian: "Stage this room in Scandinavian style with light wood furniture, neutral textiles, cozy textures, and minimalist décor. Emphasize functionality and hygge comfort.",
    luxury: "Stage this room with high-end luxury furniture featuring rich materials like marble, velvet, and gold accents. Create an opulent, sophisticated atmosphere.",
    coastal: "Stage this room with coastal-inspired furniture in light blues, whites, and natural textures. Add nautical elements and beach-inspired décor.",
    farmhouse: "Stage this room with rustic farmhouse furniture featuring reclaimed wood, vintage pieces, and cozy textiles in warm, earthy tones."
  };

  const roomSpecific = roomType === 'Bedroom' ? ' Focus on bedroom furniture like beds, nightstands, and dressers.' :
                     roomType === 'Living room' ? ' Focus on living room furniture like sofas, coffee tables, and entertainment centers.' :
                     roomType === 'Dining room' ? ' Focus on dining furniture like tables, chairs, and storage.' :
                     roomType === 'Kitchen' ? ' Focus on kitchen elements and dining areas.' :
                     roomType === 'Office' ? ' Focus on office furniture like desks, chairs, and storage.' : '';

  let prompt = `${styleDescriptions[furnitureStyle] || styleDescriptions.standard}${roomSpecific}. Do not alter or remove any walls, doors, or architectural features. Focus only on adding or arranging furniture and decor to professionally stage the room.`;
  
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
  console.log('Processing image request received');
  
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided' });
    }

    if (!genAI) {
      return res.status(500).json({ error: 'AI service not properly configured' });
    }

    const { roomType = 'Living room', furnitureStyle = 'standard', additionalPrompt = '' } = req.body;
    
    console.log('Processing options:', { roomType, furnitureStyle, additionalPrompt });

    // Downscale the image if needed
    console.log("Processing image...");
    const processedImageBuffer = await downscaleImage(req.file.buffer);
    const base64Image = processedImageBuffer.toString("base64");

    // Generate prompt based on user preferences
    const promptText = generatePrompt(roomType, furnitureStyle, additionalPrompt);
    console.log('Generated prompt:', promptText);

    const prompt = [
      { text: promptText },
      {
        inlineData: {
          mimeType: "image/jpeg",
          data: base64Image, 
        },
      },
    ];

    console.log("Processing image with Gemini 2.5 Flash Image Preview...");
    
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
        console.log("Successfully processed image");
        
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
