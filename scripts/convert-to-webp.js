#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Convert PNG files to WebP format
 * @param {string} inputDir - Directory containing PNG files
 * @param {string} outputDir - Directory to save WebP files
 * @param {number} quality - WebP quality (1-100)
 */
async function convertPngsToWebp(inputDir, outputDir = null, quality = 80) {
  try {
    // Use same directory if no output specified
    if (!outputDir) {
      outputDir = inputDir;
    }

    // Ensure output directory exists
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Get all PNG files in the directory
    const files = fs.readdirSync(inputDir);
    const pngFiles = files.filter(file => 
      path.extname(file).toLowerCase() === '.png'
    );

    if (pngFiles.length === 0) {
      console.log(`No PNG files found in ${inputDir}`);
      return;
    }

    console.log(`Found ${pngFiles.length} PNG files to convert...`);

    let convertedCount = 0;
    let totalSavings = 0;

    for (const pngFile of pngFiles) {
      const inputPath = path.join(inputDir, pngFile);
      const baseName = path.basename(pngFile, '.png');
      const outputPath = path.join(outputDir, `${baseName}.webp`);

      try {
        // Get original file size
        const originalStats = fs.statSync(inputPath);
        const originalSize = originalStats.size;

        // Convert PNG to WebP
        await sharp(inputPath)
          .webp({ quality: quality })
          .toFile(outputPath);

        // Get new file size
        const newStats = fs.statSync(outputPath);
        const newSize = newStats.size;
        const savings = originalSize - newSize;
        const savingsPercent = ((savings / originalSize) * 100).toFixed(1);

        totalSavings += savings;
        convertedCount++;

        console.log(`✅ ${pngFile} → ${baseName}.webp (${savingsPercent}% smaller)`);

        // Optionally remove original PNG file
        // Uncomment the next line if you want to delete original PNGs
        // fs.unlinkSync(inputPath);

      } catch (error) {
        console.error(`❌ Failed to convert ${pngFile}:`, error.message);
      }
    }

    const totalSavingsMB = (totalSavings / (1024 * 1024)).toFixed(2);
    console.log(`\n🎉 Conversion complete!`);
    console.log(`📊 Converted: ${convertedCount}/${pngFiles.length} files`);
    console.log(`💾 Total space saved: ${totalSavingsMB} MB`);

  } catch (error) {
    console.error('Error during conversion:', error.message);
    process.exit(1);
  }
}

// Command line usage
const args = process.argv.slice(2);

if (args.length === 0) {
  console.log(`
🖼️  PNG to WebP Converter

Usage:
  node scripts/convert-to-webp.js <input-directory> [output-directory] [quality]

Examples:
  node scripts/convert-to-webp.js public/media
  node scripts/convert-to-webp.js public/media public/media/webp
  node scripts/convert-to-webp.js public/media public/media 90

Options:
  input-directory   Directory containing PNG files (required)
  output-directory  Directory to save WebP files (optional, defaults to input directory)
  quality          WebP quality 1-100 (optional, defaults to 80)
`);
  process.exit(1);
}

const inputDir = path.resolve(args[0]);
const outputDir = args[1] ? path.resolve(args[1]) : null;
const quality = args[2] ? parseInt(args[2], 10) : 80;

// Validate input directory
if (!fs.existsSync(inputDir)) {
  console.error(`❌ Input directory does not exist: ${inputDir}`);
  process.exit(1);
}

if (!fs.statSync(inputDir).isDirectory()) {
  console.error(`❌ Input path is not a directory: ${inputDir}`);
  process.exit(1);
}

// Validate quality
if (quality < 1 || quality > 100) {
  console.error(`❌ Quality must be between 1 and 100, got: ${quality}`);
  process.exit(1);
}

console.log(`🚀 Starting conversion...`);
console.log(`📁 Input: ${inputDir}`);
console.log(`📁 Output: ${outputDir || inputDir}`);
console.log(`🎨 Quality: ${quality}`);
console.log('');

convertPngsToWebp(inputDir, outputDir, quality);
