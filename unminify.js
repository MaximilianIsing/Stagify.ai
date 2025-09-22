import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Unminify Script
 * Deletes minified versions and restores original files from to build/to minify
 */

const publicDir = path.join(__dirname, 'public');
const toMinifyDir = path.join(__dirname, 'to build', 'to minify');

// Files to restore from to minify directory
const filesToRestore = [
  'scripts/app.js',
  'scripts/carousel.js', 
  'scripts/language-loader.js',
  'scripts/sponsors-scroll.js',
  'scripts/star-border.js',
  'styles/carousel.css',
  'styles/star-border.css',
  'styles/styles.css'
];

console.log('Starting unminify process...');

// Check if to minify directory exists
if (!fs.existsSync(toMinifyDir)) {
  console.error('Error: to build/to minify directory does not exist');
  process.exit(1);
}

// Restore each file from to minify to public
filesToRestore.forEach(filePath => {
  const sourcePath = path.join(toMinifyDir, filePath);
  const destPath = path.join(publicDir, filePath);
  
  // Ensure destination directory exists
  const destDir = path.dirname(destPath);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }
  
  if (fs.existsSync(sourcePath)) {
    try {
      // Copy file from to minify to public
      fs.copyFileSync(sourcePath, destPath);
      console.log(`✓ Restored: ${filePath}`);
    } catch (error) {
      console.error(`✗ Error restoring ${filePath}:`, error.message);
    }
  } else {
    console.warn(`⚠ Source file not found: ${sourcePath}`);
  }
});

// Remove the to minify directory
try {
  fs.rmSync(toMinifyDir, { recursive: true, force: true });
  console.log('✓ Removed to build/to minify directory');
} catch (error) {
  console.error('✗ Error removing to minify directory:', error.message);
}

console.log('Unminify process completed!');
