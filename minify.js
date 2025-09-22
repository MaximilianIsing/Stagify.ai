import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const PUBLIC_DIR = 'public';
const TO_BUILD_DIR = 'to build';
const TO_MINIFY_DIR = path.join(TO_BUILD_DIR, 'to minify');

// API endpoints
const CSS_MINIFIER_URL = 'https://www.toptal.com/developers/cssminifier/api/raw';
const JS_MINIFIER_URL = 'https://www.toptal.com/developers/javascript-minifier/api/raw';

// File paths
const SCRIPTS_DIR = path.join(PUBLIC_DIR, 'scripts');
const STYLES_DIR = path.join(PUBLIC_DIR, 'styles');

/**
 * Make HTTP POST request to minify API
 */
function minifyFile(content, url) {
    return new Promise((resolve, reject) => {
        const postData = `input=${encodeURIComponent(content)}`;
        
        const options = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        const req = https.request(url, options, (res) => {
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
            });
            res.on('end', () => {
                if (res.statusCode === 200) {
                    resolve(data);
                } else {
                    reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                }
            });
        });

        req.on('error', (err) => {
            reject(err);
        });

        req.write(postData);
        req.end();
    });
}

/**
 * Ensure directory exists
 */
function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

/**
 * Copy file from source to destination
 */
function copyFile(src, dest) {
    const destDir = path.dirname(dest);
    ensureDir(destDir);
    fs.copyFileSync(src, dest);
}

/**
 * Process all files in a directory
 */
async function processFiles(sourceDir, fileExtension, minifierUrl) {
    const files = fs.readdirSync(sourceDir).filter(file => file.endsWith(fileExtension));
    
    console.log(`Processing ${files.length} ${fileExtension} files from ${sourceDir}...`);
    
    for (const file of files) {
        const sourcePath = path.join(sourceDir, file);
        
        try {
            // Read original file
            const originalContent = fs.readFileSync(sourcePath, 'utf8');
            
            // Copy to "to minify" folder (inside "to build") maintaining structure
            const relativePath = path.relative(PUBLIC_DIR, sourcePath);
            const toMinifyPath = path.join(TO_MINIFY_DIR, relativePath);
            copyFile(sourcePath, toMinifyPath);
            console.log(`Copied ${relativePath} to to minify folder`);
            
            // Minify the content
            console.log(`Minifying ${file}...`);
            const minifiedContent = await minifyFile(originalContent, minifierUrl);
            
            // Replace original file with minified version
            fs.writeFileSync(sourcePath, minifiedContent);
            console.log(`Replaced original ${file} with minified version`);
            
        } catch (error) {
            console.error(`Error processing ${file}:`, error.message);
        }
    }
}

/**
 * Main function
 */
async function main() {
    try {
        console.log('Starting minification process...');
        
        // Ensure directories exist
        ensureDir(TO_MINIFY_DIR);
        ensureDir(TO_BUILD_DIR);
        
        // Process JavaScript files
        await processFiles(SCRIPTS_DIR, '.js', JS_MINIFIER_URL);
        
        // Process CSS files
        await processFiles(STYLES_DIR, '.css', CSS_MINIFIER_URL);
        
        console.log('Minification process completed successfully!');
        console.log(`Original files backed up in: ${TO_MINIFY_DIR}`);
        console.log(`Public files have been replaced with minified versions`);
        
    } catch (error) {
        console.error('Minification process failed:', error);
        process.exit(1);
    }
}

// Run the script
main();

export { main, minifyFile, processFiles };
