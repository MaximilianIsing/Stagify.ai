// Multer upload configs, extracted verbatim from server.js. These are pure config
// with no dependency on server state — each instance is constructed once at import
// and only handed to the routers that consume it (staging, chat, admin). Kept here
// so server.js stays "just wiring." `multer` still lives in server.js too, for its
// MulterError handler.
import multer from 'multer';

// memoryStorage buffers uploads in RAM (no temp files on disk); shared by the three
// configs below. hostImageUpload constructs its own instance, matching the original.
const storage = multer.memoryStorage();

export const imageFileFilter = (req, file, cb) => {
  const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only PNG, JPG, JPEG, and WebP files are allowed'));
  }
};

// Accept a file that is a PDF by MIME type OR by .pdf extension (some clients send
// application/octet-stream for PDFs).
export const pdfFileFilter = (req, file, cb) => {
  if (file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf')) {
    cb(null, true);
  } else {
    cb(new Error('Only PDF files are allowed'));
  }
};

// Virtual-staging multipart upload (1 room image + up to 5 furniture refs).
export const stagingProcessUpload = multer({
  storage: storage,
  // 25MB per file. memoryStorage buffers every file whole and .fields() allows up to
  // 6 files (1 room image + 5 furniture refs), so this caps a request at ~150MB of
  // RAM instead of the previous ~600MB. Photos are downscaled to 1920x1080 after
  // receipt anyway, so 25MB is already far above any real phone photo.
  limits: {
    fileSize: 25 * 1024 * 1024,
  },
  fileFilter: imageFileFilter
}).fields([
  { name: 'image', maxCount: 1 },
  { name: 'furnitureImage', maxCount: 5 }
]);

// Configure multer for PDF uploads
export const pdfUpload = multer({
  storage: storage,
  limits: {
    fileSize: 25 * 1024 * 1024, // 25MB — floor-plan PDFs are small; buffered whole in RAM
  },
  fileFilter: pdfFileFilter
});

// Configure multer for chat file uploads (images, PDFs, text files)
export const chatUpload = multer({
  storage: storage,
  limits: {
    // .array('files', 5) buffers up to 5 files whole in RAM, so 20MB/file caps a
    // request at ~100MB + the history field, vs the previous ~250MB+.
    fileSize: 20 * 1024 * 1024, // 20MB per file
    fieldSize: 25 * 1024 * 1024, // conversation history (base64 images); matches the /api/chat JSON cap
  },
  fileFilter: (req, file, cb) => {
    // Allow all files - let the AI handle unsupported file types
    cb(null, true);
  }
});

// ── Public image hosting (admin-managed) ───────────────────────────────────
// Admins upload an image from the dashboard; it's stored on the persistent disk
// and served publicly at /i/<id> behind an unguessable random id. A manifest
// (index.json) records the metadata so the dashboard can list and unhost them.
// Also consumed by routes/admin.js, which maps mime → file extension on save.
export const HOSTED_IMAGE_MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

// Safe raster types only (deliberately no SVG — it can carry script and would
// execute on our own origin). Accepts exactly the keys of HOSTED_IMAGE_MIME_EXT.
export const hostedImageFileFilter = (req, file, cb) => {
  if (HOSTED_IMAGE_MIME_EXT[file.mimetype]) cb(null, true);
  else cb(new Error('Only PNG, JPG, WebP, and GIF images can be hosted'));
};

// Dedicated multer instance: safe raster types only, 25 MB cap to protect the
// persistent disk.
export const hostImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: hostedImageFileFilter,
}).single('image');
