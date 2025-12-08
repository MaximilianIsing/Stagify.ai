import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { GoogleGenerativeAI } from "@google/generative-ai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read DEBUG_MODE from environment or debug.txt (same as server.js)
let DEBUG_MODE = false;
try {
  let debugValue = process.env.DEBUG;
  if (debugValue === undefined) {
    const debugFile = path.join(__dirname, 'debug.txt');
    if (fs.existsSync(debugFile)) {
      debugValue = fs.readFileSync(debugFile, 'utf8').trim();
    }
  }
  if (debugValue !== undefined) {
    DEBUG_MODE = debugValue.toLowerCase() === 'true';
  }
} catch (error) {
  // Default to false if can't read
  DEBUG_MODE = false;
}

// Cache the Gemini client instance to avoid reinitializing on every call
let cachedGenAI = null;
let cachedApiKey = null;

/**
 * Reads the API key from environment variable or key.txt
 * @returns {string} The API key
 */
function readApiKey() {
  // Try environment variable first (Render), then fall back to local file
  let apiKey = process.env.GOOGLE_AI_API_KEY || process.env.GEMINI_API_KEY;
  if (apiKey === undefined) {
    const keyPath = path.resolve(__dirname, "key.txt");
  try {
      if (fs.existsSync(keyPath)) {
        apiKey = fs.readFileSync(keyPath, "utf8").trim();
    }
  } catch (error) {
      if (error.code !== "ENOENT") {
    throw error;
  }
}
  }
  if (!apiKey) {
    throw new Error("Google AI API key not found. Set GOOGLE_AI_API_KEY or GEMINI_API_KEY environment variable, or create key.txt with your Gemini API key.");
  }
  return apiKey;
}

/**
 * Gets the MIME type from data URL or file extension
 * @param {string} dataUrlOrPath - Data URL (data:image/png;base64,...) or file path
 * @returns {string} MIME type
 */
function getMimeType(dataUrlOrPath) {
  // If it's a data URL, extract MIME type
  if (dataUrlOrPath.startsWith('data:')) {
    const mimeMatch = dataUrlOrPath.match(/data:([^;]+)/);
    if (mimeMatch) {
      return mimeMatch[1];
    }
  }
  // Otherwise, try to get from file extension
  const ext = path.extname(dataUrlOrPath).toLowerCase();
  const mimeTypes = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
  };
  return mimeTypes[ext] || "image/png";
}

/**
 * Extracts base64 data from a data URL or image buffer
 * @param {string|Buffer} imageData - Data URL string or Buffer
 * @returns {string} Base64 string (without data URL prefix)
 */
function extractBase64(imageData) {
  if (Buffer.isBuffer(imageData)) {
    return imageData.toString("base64");
  }
  if (typeof imageData === 'string') {
    if (imageData.startsWith('data:')) {
      // Extract base64 from data URL
      const base64Match = imageData.match(/base64,(.+)$/);
      if (base64Match) {
        return base64Match[1];
      }
    }
    // Assume it's already base64
    return imageData;
  }
  throw new Error("Invalid image data format");
}

/**
 * Converts a top-down blueprint to a top-down 3D render using Gemini
 * @param {string|Buffer} blueprintImage - Data URL, base64 string, or Buffer of the blueprint image
 * @param {string} mimeType - Optional MIME type (auto-detected if not provided)
 * @param {Array<{image: string|Buffer, mimeType?: string}>} furnitureImages - Optional array of furniture images to include in the render
 * @param {string} additionalPrompt - Optional additional prompt/instructions from the AI (e.g., theme, style, specific requirements)
 * @returns {Promise<Buffer>} Buffer containing the generated 3D render image
 */
async function blueprintTo3D(blueprintImage, mimeType = null, furnitureImages = [], additionalPrompt = null) {
  if (DEBUG_MODE) {
  console.log("=== BLUEPRINT TO 3D RENDER ===\n");
  }

  // Read API key
  const apiKey = readApiKey();

  // Initialize Gemini (reuse cached instance if API key hasn't changed)
  let genAI;
  if (cachedGenAI && cachedApiKey === apiKey) {
    genAI = cachedGenAI;
    if (DEBUG_MODE) {
    console.log("Reusing cached Gemini client");
    }
  } else {
    if (DEBUG_MODE) {
  console.log("Initializing Gemini...");
    }
    genAI = new GoogleGenerativeAI(apiKey);
    cachedGenAI = genAI;
    cachedApiKey = apiKey;
  }

  // Extract base64 and MIME type for blueprint
  const imageBase64 = extractBase64(blueprintImage);
  const detectedMimeType = mimeType || getMimeType(typeof blueprintImage === 'string' ? blueprintImage : 'image/png');

  // Build the content array starting with the blueprint image
  const content = [
    {
      inlineData: {
        data: imageBase64,
        mimeType: detectedMimeType,
      },
    }
  ];

  // Add furniture images if provided
  if (furnitureImages && furnitureImages.length > 0) {
    if (DEBUG_MODE) {
    console.log(`Including ${furnitureImages.length} furniture image(s) in the render`);
    }
    for (let i = 0; i < furnitureImages.length; i++) {
      const furnitureImage = furnitureImages[i];
      const furnitureBase64 = extractBase64(furnitureImage.image);
      const furnitureMimeType = furnitureImage.mimeType || getMimeType(typeof furnitureImage.image === 'string' ? furnitureImage.image : 'image/png');
      
      content.push({
        inlineData: {
          data: furnitureBase64,
          mimeType: furnitureMimeType,
        },
      });
    }
  }

  // Create the prompt
  let prompt = `You are an expert 3D visualization artist. 

Analyze this top-down room blueprint image and create a top-down 3D render of the room.

CRITICAL REQUIREMENT - THE OUTPUT MUST BE TOP-DOWN:
- The camera/viewpoint MUST be positioned directly above the room, looking straight down (90-degree angle from horizontal)
- This is a TOP-DOWN view, also known as a bird's eye view or plan view
- The output image MUST show the room from above, as if you are looking down at a floor plan
- DO NOT use any angled perspective, side view, or isometric view - ONLY top-down
- The floor should be visible as the primary surface, with walls appearing as vertical lines or edges around the perimeter`;

  if (furnitureImages && furnitureImages.length > 0) {
    prompt += `\n\nIMPORTANT: Additional furniture images have been provided. Include these furniture pieces in the 3D render based on the blueprint layout. Place the furniture appropriately within the room according to the blueprint's layout and scale. When placing furniture, show it from the top-down perspective (as if looking down at the furniture from above).`;
  }

  prompt += `\n\nRequirements:
- Generate a TOP-DOWN view (bird's eye view) looking STRAIGHT DOWN at the room - this is MANDATORY
- The viewing angle must be 90 degrees from horizontal (directly overhead)
- Show all walls, doors, windows, and furniture in 3D perspective but from the top-down angle
- Use appropriate colors and textures for different elements (walls, floor, furniture, etc.)
- Maintain the exact layout and proportions from the blueprint`;

  if (furnitureImages && furnitureImages.length > 0) {
    prompt += `\n- Include the furniture from the provided furniture images, placing them appropriately in the room according to the blueprint, showing them from the top-down perspective`;
  }

  prompt += `\n- Make it look like a professional 3D architectural visualization
- The output MUST be a top-down 3D render image - viewing the room from directly above
- REMEMBER: The output must show the room from above, not from any side or angled perspective`;

  // Add additional prompt/instructions from the AI if provided
  if (additionalPrompt && additionalPrompt.trim()) {
    prompt += `\n\nADDITIONAL REQUIREMENTS FROM USER:
${additionalPrompt.trim()}

Please incorporate these requirements into the 3D render while maintaining the top-down perspective.`;
  }

  prompt += `\n\nGenerate the 3D render now. Ensure it is a TOP-DOWN view.`;

  if (DEBUG_MODE) {
  console.log("Sending request to Gemini...");
  }
  
  try {
    // Use Gemini 3 Pro Image Preview for image understanding and generation
    const model = genAI.getGenerativeModel({ model: "gemini-3-pro-image-preview" });
    
    // Add the prompt text to the content array
    content.push({ text: prompt });
    
    const result = await model.generateContent(content);

    // Check response structure
    const response = result.response;
    
    // The response should have candidates with content
    if (response && response.candidates && response.candidates[0]) {
      const candidate = response.candidates[0];
      const content = candidate.content;
      
      if (content && content.parts) {
        // Try to extract image from response
        for (const part of content.parts) {
          if (part.inlineData && part.inlineData.data) {
            // Return the generated image as a Buffer
            const imageBuffer = Buffer.from(part.inlineData.data, "base64");
            if (DEBUG_MODE) {
            console.log(`\n✓ 3D render generated successfully`);
            }
            return imageBuffer;
          }
        }
        
        // If no image, get text response
        const textParts = content.parts.filter(p => p.text);
        if (textParts.length > 0) {
          const text = textParts.map(p => p.text).join("\n");
          if (DEBUG_MODE) {
          console.log("Gemini response (text):", text.substring(0, 500));
          }
          throw new Error("Gemini returned text instead of an image. This model may not support image generation. Response: " + text.substring(0, 200));
        }
      }
    }
    
    // If we get here, the response format is unexpected
    if (DEBUG_MODE) {
    console.log("Full response:", JSON.stringify(response, null, 2).substring(0, 1000));
    }
    throw new Error("Unexpected response format from Gemini");
  } catch (error) {
    console.error("Error generating 3D render:", error.message);
    throw error;
  }
}

export { blueprintTo3D };

// CLI support
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const argv = process.argv.slice(2);
    
    if (argv.length === 0) {
      console.log("Usage: node cad-handling.js <blueprintImage> [outputImage]");
      console.log("");
      console.log("If only blueprint image is provided, output will be auto-generated as <name>-render.png");
      console.log("");
      console.log("Examples:");
      console.log("  node cad-handling.js Room1.png");
      console.log("  node cad-handling.js Room1.png output.png");
      process.exit(1);
    }

    const imagePath = argv[0];
    let outputPath = argv[1];

    // If no output path specified, auto-generate one
    if (!outputPath) {
      const parsedPath = path.parse(imagePath);
      outputPath = path.join(parsedPath.dir, `${parsedPath.name}-render${parsedPath.ext || ".png"}`);
    }

    try {
      // Read image file for CLI usage
      const imageBuffer = fs.readFileSync(imagePath);
      const mimeType = getMimeType(imagePath);
      const resultBuffer = await blueprintTo3D(imageBuffer, mimeType);
      
      // Save to file
      const resolvedOutputPath = path.resolve(outputPath);
      await fs.promises.mkdir(path.dirname(resolvedOutputPath), { recursive: true });
      await fs.promises.writeFile(resolvedOutputPath, resultBuffer);
      console.log(`\n✓ 3D render saved to: ${resolvedOutputPath}`);
      console.log("\n=== COMPLETE ===");
    } catch (error) {
      console.error("Error:", error.message || error);
      if (error.stack) {
        console.error(error.stack);
      }
      process.exit(1);
    }
  })();
}
