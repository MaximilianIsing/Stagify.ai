import { GoogleGenerativeAI } from "@google/generative-ai";
import * as fs from "node:fs";
import sharp from "sharp";

/**
 * Downscales an image to fit within 1920x1080 while maintaining aspect ratio
 * @param {string} inputPath - Path to the input image
 * @param {string} outputPath - Path for the processed image
 * @returns {Promise<void>}
 */
async function downscaleImage(inputPath, outputPath) {
  try {
    const image = sharp(inputPath);
    const metadata = await image.metadata();
    
    console.log(`Original image dimensions: ${metadata.width}x${metadata.height}`);
    
    // Check if downscaling is needed
    if (metadata.width <= 1920 && metadata.height <= 1080) {
      console.log("Image is already within size limits, copying original...");
      fs.copyFileSync(inputPath, outputPath);
      return;
    }
    
    // Calculate the scaling factor to fit within 1920x1080 while maintaining aspect ratio
    const scaleWidth = 1920 / metadata.width;
    const scaleHeight = 1080 / metadata.height;
    const scale = Math.min(scaleWidth, scaleHeight);
    
    const newWidth = Math.floor(metadata.width * scale);
    const newHeight = Math.floor(metadata.height * scale);
    
    console.log(`Downscaling to: ${newWidth}x${newHeight} (scale factor: ${scale.toFixed(3)})`);
    
    await image
      .resize(newWidth, newHeight, {
        kernel: sharp.kernel.lanczos3,
        withoutEnlargement: true
      })
      .toFile(outputPath);
      
    console.log(`Image successfully downscaled  and saved to: ${outputPath}`);
  } catch (error) {
    console.error("Error downscaling image:", error);
    throw error;
  }
}




async function main() {
  const key = fs.readFileSync("key.txt", "utf8");
  const ai = new GoogleGenerativeAI(key);

  const originalImagePath = "Empty.png";
  const processedImagePath = "Empty_processed.jpg";
  
  // Downscale the image first
  console.log("Downscaling image if needed...");
  await downscaleImage(originalImagePath, processedImagePath);
  
  // Read the processed image
  const imageData = fs.readFileSync(processedImagePath);
  const base64Image = imageData.toString("base64");

  const prompt = [
    { text: "Stage this room in a modern style by adding a low-profile sectional sofa in a neutral color such as gray, white, or black, a sleek glass or polished stone coffee table with minimalist lines, and an accent chair with a bold sculptural design. Incorporate a large area rug in a solid tone or subtle geometric pattern to ground the space, and add statement lighting such as a slim arc floor lamp or a contemporary pendant with metallic or matte finishes. Keep accessories minimal, using a few curated décor pieces like abstract sculptures, modern art prints, or monochrome vases. Emphasize clean lines, open space, and a neutral palette with occasional bold accents to create a refined, sophisticated atmosphere. Leave the rest of the room’s architecture the same to highlight the modern furniture and design."},
    {
      inlineData: {
        mimeType: "image/jpeg",
        data: base64Image, 
      },
    },
  ];

  try {
    console.log("Processing image with Gemini 2.5 Flash Image Preview...");
    
    const model = ai.getGenerativeModel({ model: "gemini-2.5-flash-image-preview" });
    const result = await model.generateContent(prompt);
    const response = await result.response;

    if (!response || !response.candidates || response.candidates.length === 0) {
      console.error("No candidates in response");
      return;
    }
    
    for (const part of response.candidates[0].content.parts) {
      if (part.inlineData) {
        const imageData = part.inlineData.data;
        const buffer = Buffer.from(imageData, "base64");
        fs.writeFileSync("gemini-2.5-image.png", buffer);
      }
    }
    
    // Clean up the temporary processed image file
    if (fs.existsSync(processedImagePath)) {
      fs.unlinkSync(processedImagePath);
      console.log("Cleaned up temporary processed image file");
    }
  } catch (error) {
    console.error("Error:", error.message);
    console.error("Full error:", error);
    
    // Clean up the temporary processed image file even on error
    if (fs.existsSync(processedImagePath)) {
      fs.unlinkSync(processedImagePath);
      console.log("Cleaned up temporary processed image file");
    }
  }
}

main();