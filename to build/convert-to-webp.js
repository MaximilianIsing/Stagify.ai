#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Convert all PNG files in media directory to transparent WebP
 */
async function convertPngsToTransparentWebp() {
  const mediaDir = path.resolve('../to build/media-png');
  const buildDir = path.resolve('../to build/media-webp');
  
  console.log('🖼️  Converting PNG files to transparent WebP...\n');
  
  try {
    // Clean and create build directory
    if (fs.existsSync(buildDir)) {
      fs.rmSync(buildDir, { recursive: true, force: true });
    }
    fs.mkdirSync(buildDir, { recursive: true });

    // Find all PNG files recursively in media directory
    const pngFiles = await findPngFiles(mediaDir);
    
    if (pngFiles.length === 0) {
      console.log('No PNG files found in media directory');
      return;
    }

    console.log(`Found ${pngFiles.length} PNG files to convert...`);
    
    let convertedCount = 0;
    let totalSavings = 0;

    for (const pngFile of pngFiles) {
      try {
        // Create WebP file in build directory with same folder structure
        const relativePath = path.relative(mediaDir, pngFile);
        const baseName = path.basename(relativePath, '.png');
        const dirName = path.dirname(relativePath);
        
        // Create corresponding directory structure in build folder
        const outputDir = dirName === '.' ? buildDir : path.join(buildDir, dirName);
        if (!fs.existsSync(outputDir)) {
          fs.mkdirSync(outputDir, { recursive: true });
        }
        
        const outputPath = path.join(outputDir, `${baseName}.webp`);

        // Get original file size
        const originalStats = fs.statSync(pngFile);
        const originalSize = originalStats.size;

        // Convert PNG to WebP with perfect transparency preservation
        await sharp(pngFile)
          .webp({ 
            quality: 95, // High quality
            alphaQuality: 100, // Perfect alpha channel quality
            lossless: false,
            nearLossless: false,
            smartSubsample: false, // Better for transparent images
            effort: 6, // Maximum effort for best compression
            mixed: true // Allow mixed compression for better results
          })
          .toFile(outputPath);

        // Get new file size
        const newStats = fs.statSync(outputPath);
        const newSize = newStats.size;
        const savings = originalSize - newSize;
        const savingsPercent = ((savings / originalSize) * 100).toFixed(1);

        totalSavings += savings;
        convertedCount++;

        console.log(`✅ ${relativePath} → ${path.relative(buildDir, outputPath)} (${savingsPercent}% smaller)`);

      } catch (error) {
        console.error(`❌ Failed to convert ${pngFile}:`, error.message);
      }
    }

    const totalSavingsMB = (totalSavings / (1024 * 1024)).toFixed(2);
    console.log(`\n🎉 Conversion complete!`);
    console.log(`📊 Converted: ${convertedCount}/${pngFiles.length} files`);
    console.log(`💾 Total space saved: ${totalSavingsMB} MB`);
    console.log(`📁 All transparent WebP files saved to: to build/media-webp/`);

  } catch (error) {
    console.error('Error during conversion:', error.message);
    process.exit(1);
  }
}

/**
 * Recursively find all PNG files in a directory
 * @param {string} dir - Directory to search
 * @returns {Promise<string[]>} Array of PNG file paths
 */
async function findPngFiles(dir) {
  const pngFiles = [];
  
  async function scanDirectory(currentDir) {
    try {
      const items = fs.readdirSync(currentDir);
      
      for (const item of items) {
        const fullPath = path.join(currentDir, item);
        const stat = fs.statSync(fullPath);
        
        if (stat.isDirectory()) {
          // Skip node_modules and other irrelevant directories
          if (!item.includes('node_modules') && !item.includes('.git')) {
            await scanDirectory(fullPath);
          }
        } else if (stat.isFile() && path.extname(item).toLowerCase() === '.png') {
          pngFiles.push(fullPath);
        }
      }
    } catch (error) {
      console.warn(`Warning: Could not read directory ${currentDir}:`, error.message);
    }
  }
  
  await scanDirectory(dir);
  return pngFiles;
}

// Run the conversion
console.log('🚀 Converting PNG files to transparent WebP...\n');
convertPngsToTransparentWebp();
