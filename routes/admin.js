// admin routes, extracted verbatim from server.js.
import express from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

export default function createAdminRouter(deps) {
  const { authStore, uptimeMonitor, enterpriseStore, hostImageUpload, DEBUG_MODE, setSensitiveHeaders, getMemoriesFile, getDataLogDir, getHostedImagesDir, readHostedImagesManifest, writeHostedImagesManifest, protectLogs , __dirname, HOSTED_IMAGE_MIME_EXT } = deps;
  const router = express.Router();

router.get('/admin', (req, res) => {
  setSensitiveHeaders(res);
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

router.post('/api/host-image', protectLogs, (req, res) => {
  hostImageUpload(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err.message || 'Upload failed' });
    }
    if (!req.file || !req.file.buffer || !req.file.buffer.length) {
      return res.status(400).json({ error: 'No image file provided' });
    }
    try {
      const ext = HOSTED_IMAGE_MIME_EXT[req.file.mimetype] || 'bin';
      const id = crypto.randomBytes(16).toString('hex'); // 32 hex chars, unguessable
      const file = id + '.' + ext;
      fs.writeFileSync(path.join(getHostedImagesDir(), file), req.file.buffer);
      const entry = {
        id,
        file,
        mime: req.file.mimetype,
        ext,
        originalName: req.file.originalname || file,
        size: req.file.size || req.file.buffer.length,
        uploadedAt: new Date().toISOString(),
      };
      const manifest = readHostedImagesManifest();
      manifest.push(entry);
      writeHostedImagesManifest(manifest);
      const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https')
        .split(',')[0]
        .trim();
      const url = proto + '://' + req.get('host') + '/i/' + id;
      console.log('[host-image] hosted', file, '(' + entry.size + ' bytes)');
      return res.json({ ok: true, id, path: '/i/' + id, url, entry });
    } catch (e) {
      console.error('[host-image] save failed', e);
      return res.status(500).json({ error: 'Failed to save image' });
    }
  });
});

router.get('/api/hosted-images', protectLogs, (req, res) => {
  const images = readHostedImagesManifest()
    .slice()
    .sort((a, b) => new Date(b.uploadedAt || 0) - new Date(a.uploadedAt || 0))
    .map((e) => Object.assign({}, e, { path: '/i/' + e.id }));
  return res.json({ images });
});

router.delete('/api/hosted-images/:id', protectLogs, (req, res) => {
  const id = String(req.params.id || '');
  if (!/^[a-f0-9]{16,64}$/.test(id)) {
    return res.status(400).json({ error: 'Invalid id' });
  }
  const manifest = readHostedImagesManifest();
  const idx = manifest.findIndex((e) => e && e.id === id);
  if (idx === -1) {
    return res.status(404).json({ error: 'Not found' });
  }
  const [entry] = manifest.splice(idx, 1);
  try {
    const filePath = path.join(getHostedImagesDir(), entry.file);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) {
    console.error('[host-image] file delete failed', e);
  }
  writeHostedImagesManifest(manifest);
  console.log('[host-image] unhosted', entry.file);
  return res.json({ ok: true });
});

router.get('/authstore', protectLogs, (req, res) => {
  try {
    // Serve a LIVE snapshot rebuilt from SQLite in the legacy auth-store.json
    // shape. This keeps the admin backup download working after the move off
    // flat files, and the output is a valid rollback/re-import payload.
    const snapshot = authStore.exportStore();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="auth-store.json"');
    res.send(JSON.stringify(snapshot, null, 2));
  } catch (error) {
    console.error('Error serving auth store snapshot:', error);
    res.status(500).json({
      error: 'Failed to retrieve auth store',
      message: error.message,
    });
  }
});

router.get('/promptlogs', protectLogs, (req, res) => {
  try {
    let logDir;
    
    if (process.env.RENDER && fs.existsSync('/data')) {
      // Use Render's mounted disk
      logDir = '/data';
    } else {
      // Use project data folder for local development
      logDir = path.join(__dirname, 'data');
    }

    const logFile = path.join(logDir, 'prompt_logs.csv');
    
    if (fs.existsSync(logFile)) {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'inline; filename="prompt_logs.csv"');
      res.sendFile(logFile);
    } else {
      res.status(404).json({ 
        error: 'Log file not found',
        message: 'No prompt logs are available yet'
      });
    }
  } catch (error) {
    console.error('Error serving prompt log file:', error);
    res.status(500).json({ 
      error: 'Failed to retrieve prompt logs',
      message: error.message
    });
  }
});

router.get('/contactlogs', protectLogs, (req, res) => {
  try {
    let logDir;
    
    if (process.env.RENDER && fs.existsSync('/data')) {
      // Use Render's mounted disk
      logDir = '/data';
    } else {
      // Use project data folder for local development
      logDir = path.join(__dirname, 'data');
    }

    const logFile = path.join(logDir, 'contact_logs.csv');
    
    if (fs.existsSync(logFile)) {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'inline; filename="contact_logs.csv"');
      res.sendFile(logFile);
    } else {
      res.status(404).json({ 
        error: 'Log file not found',
        message: 'No contact logs are available yet'
      });
    }
  } catch (error) {
    console.error('Error serving contact log file:', error);
    res.status(500).json({ 
      error: 'Failed to retrieve contact logs',
      message: error.message
    });
  }
});

router.get('/email-open-logs', protectLogs, (req, res) => {
  try {
    const logFile = path.join(getDataLogDir(), 'email_open_logs.csv');

    if (fs.existsSync(logFile)) {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'inline; filename="email_open_logs.csv"');
      res.sendFile(logFile);
    } else {
      res.status(404).json({
        error: 'Log file not found',
        message: 'No email open logs are available yet',
      });
    }
  } catch (error) {
    console.error('Error serving email open log file:', error);
    res.status(500).json({
      error: 'Failed to retrieve email open logs',
      message: error.message,
    });
  }
});

router.get('/memories', protectLogs, (req, res) => {
  try {
    const memoriesFile = getMemoriesFile();
    
    if (fs.existsSync(memoriesFile)) {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', 'inline; filename="memories.json"');
      res.sendFile(memoriesFile);
    } else {
      res.status(404).json({ 
        error: 'File not found',
        message: 'No memories are available yet'
      });
    }
  } catch (error) {
    console.error('Error serving memories file:', error);
    res.status(500).json({ 
      error: 'Failed to retrieve memories',
      message: error.message
    });
  }
});

router.get('/resetmemories', protectLogs, (req, res) => {
  try {
    const memoriesFile = getMemoriesFile();
    const logDir = path.dirname(memoriesFile);
    
    // Ensure directory exists
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    
    // Write empty object to reset all memories
    const emptyMemories = {};
    fs.writeFileSync(memoriesFile, JSON.stringify(emptyMemories, null, 2));
    
    if (DEBUG_MODE) {
      console.log('✓ Successfully reset all memories');
    }
    
    res.status(200).json({ 
      success: true,
      message: 'All memories have been reset successfully'
    });
  } catch (error) {
    console.error('Error resetting memories:', error);
    res.status(500).json({ 
      error: 'Failed to reset memories',
      message: error.message
    });
  }
});

// Wipe all recorded uptime/incident history (admin "reset server status" button).
router.post('/api/status/reset', protectLogs, (req, res) => {
  try {
    const snapshot = uptimeMonitor.reset();
    if (DEBUG_MODE) console.log('✓ Server status (uptime) history reset');
    res.status(200).json({ success: true, message: 'Server status history reset; monitoring restarted.', snapshot });
  } catch (error) {
    console.error('Error resetting server status:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/chatlogs', protectLogs, (req, res) => {
  try {
    let logDir;
    
    if (process.env.RENDER && fs.existsSync('/data')) {
      // Use Render's mounted disk
      logDir = '/data';
    } else {
      // Use project data folder for local development
      logDir = path.join(__dirname, 'data');
    }

    const logFile = path.join(logDir, 'chat_logs.csv');
    
    if (fs.existsSync(logFile)) {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'inline; filename="chat_logs.csv"');
      res.sendFile(logFile);
    } else {
      res.status(404).json({ 
        error: 'Log file not found',
        message: 'No chat logs are available yet'
      });
    }
  } catch (error) {
    console.error('Error serving chat log file:', error);
    res.status(500).json({ 
      error: 'Failed to retrieve chat logs',
      message: error.message
    });
  }
});

router.get('/bugreports', protectLogs, (req, res) => {
  try {
    let logDir;
    
    if (process.env.RENDER && fs.existsSync('/data')) {
      // Use Render's mounted disk
      logDir = '/data';
    } else {
      // Use project data folder for local development
      logDir = path.join(__dirname, 'data');
    }

    const logFile = path.join(logDir, 'bug_reports.csv');
    
    if (fs.existsSync(logFile)) {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'inline; filename="bug_reports.csv"');
      res.sendFile(logFile);
    } else {
      res.status(404).json({ 
        error: 'Log file not found',
        message: 'No bug reports are available yet'
      });
    }
  } catch (error) {
    console.error('Error serving bug reports file:', error);
    res.status(500).json({ 
      error: 'Failed to retrieve bug reports',
      message: error.message
    });
  }
});

router.get('/masklogs', protectLogs, (req, res) => {
  try {
    let logDir;
    
    if (process.env.RENDER && fs.existsSync('/data')) {
      // Use Render's mounted disk
      logDir = '/data';
    } else {
      // Use project data folder for local development
      logDir = path.join(__dirname, 'data');
    }

    const logFile = path.join(logDir, 'mask_logs.csv');
    
    if (fs.existsSync(logFile)) {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'inline; filename="mask_logs.csv"');
      res.sendFile(logFile);
    } else {
      res.status(404).json({ 
        error: 'Log file not found',
        message: 'No mask logs are available yet'
      });
    }
  } catch (error) {
    console.error('Error serving mask logs file:', error);
    res.status(500).json({ 
      error: 'Failed to retrieve mask logs',
      message: error.message
    });
  }
});

router.get('/enterprise-domains', protectLogs, (req, res) => {
  try {
    const storePath = enterpriseStore.getStoreFilePath();
    if (fs.existsSync(storePath)) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', 'inline; filename="enterprise-domains.json"');
      res.sendFile(path.resolve(storePath));
    } else {
      res.json({ domains: [] });
    }
  } catch (error) {
    console.error('Error serving enterprise domains file:', error);
    res.status(500).json({ error: 'Failed to retrieve enterprise domains', message: error.message });
  }
});

  return router;
}
