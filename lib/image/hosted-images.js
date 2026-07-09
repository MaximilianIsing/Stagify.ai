// Persistent hosted-image store (uploaded logos/assets served back by URL) and
// its JSON manifest. The factory injects getDataLogDir so the store lives under
// the same data dir as the logs. Extracted verbatim from server.js.
import fs from 'fs';
import path from 'path';
import { logger } from '../logger.js';

export function createHostedImages({ getDataLogDir }) {
  function getHostedImagesDir() {
    const dir = path.join(getDataLogDir(), 'hosted-images');
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (e) {
        logger.error('[host-image] failed to create dir', e);
      }
    }
    return dir;
  }

  function getHostedImagesManifestPath() {
    return path.join(getHostedImagesDir(), 'index.json');
  }

  function readHostedImagesManifest() {
    try {
      const p = getHostedImagesManifestPath();
      if (!fs.existsSync(p)) return [];
      const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      logger.error('[host-image] manifest read failed', e);
      return [];
    }
  }

  function writeHostedImagesManifest(arr) {
    try {
      fs.writeFileSync(getHostedImagesManifestPath(), JSON.stringify(arr, null, 2));
      return true;
    } catch (e) {
      logger.error('[host-image] manifest write failed', e);
      return false;
    }
  }

  return { getHostedImagesDir, getHostedImagesManifestPath, readHostedImagesManifest, writeHostedImagesManifest };
}
