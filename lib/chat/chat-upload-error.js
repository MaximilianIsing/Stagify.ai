// Unsupported-file error body for the /api/chat-upload catch block, extracted
// from routes/chat.js. Pure and stateless (see test/*): given the request's
// uploaded files, it filters for the formats the pipeline can't handle (AVIF
// and any non-whitelisted image/*) and builds the user-facing "I'm unable to
// handle these file types" JSON body. Returns null when nothing unsupported is
// present, so the caller falls through to its generic 500.
import path from 'path';

export function buildUnsupportedFileErrorBody(files) {
  // Find unsupported files by checking extensions and MIME types
  const unsupportedFiles = files.filter(file => {
    const ext = path.extname(file.originalname).toLowerCase();
    const supportedImageTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
    return ext === '.avif' ||
           file.mimetype === 'image/avif' ||
           (file.mimetype.startsWith('image/') && !supportedImageTypes.includes(file.mimetype));
  });

  if (unsupportedFiles.length === 0) return null;

  const fileTypes = unsupportedFiles.map(file => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.avif' || file.mimetype === 'image/avif') {
      return 'AVIF';
    }
    return ext.toUpperCase().substring(1) || file.mimetype;
  });

  const uniqueFileTypes = [...new Set(fileTypes)];
  const fileTypeList = uniqueFileTypes.length === 1
    ? uniqueFileTypes[0]
    : uniqueFileTypes.join(', ');

  const aiResponse = `I'm unable to handle ${uniqueFileTypes.length > 1 ? 'these file types' : 'this file type'}: ${fileTypeList}. ` +
                   `Supported file types are: images (JPEG, JPG, PNG, WebP, GIF), PDFs, and text files. ` +
                   `Please convert ${unsupportedFiles.length > 1 ? 'these files' : 'this file'} to a supported format and try again.`;

  return {
    response: aiResponse,
    files: unsupportedFiles.map(f => ({ name: f.originalname, type: f.mimetype })),
    memories: { stores: [], forgets: [] }
  };
}
