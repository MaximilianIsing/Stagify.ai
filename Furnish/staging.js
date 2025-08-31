import { GoogleGenerativeAI } from "@google/generative-ai";
import * as fs from "node:fs";

async function main() {
  const key = fs.readFileSync("key.txt", "utf8");
  const ai = new GoogleGenerativeAI(key);

  const imagePath = "Empty.png";
  const imageData = fs.readFileSync(imagePath);
  const base64Image = imageData.toString("base64");

  const prompt = [
    { text: "Stage this room in a modern style by adding a modern sofa, a modern table, and a modern chair. Leave the rest of the room the same." },
    {
      inlineData: {
        mimeType: "image/png",
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
  } catch (error) {
    console.error("Error:", error.message);
    console.error("Full error:", error);
  }
}

main();