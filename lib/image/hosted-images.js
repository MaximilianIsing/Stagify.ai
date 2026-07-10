// Persistent hosted-image store (uploaded logos/assets served back by URL) and
// its JSON manifest. The factory injects getDataLogDir so the store lives under
// the same data dir as the logs. Extracted verbatim from server.js.
import fs from 'fs';
import path from 'path';
import { logger } from '../logger.js';

/**
 * Factory for the persistent hosted-image manifest store (uploaded logos/assets
 * served back by URL). Pure filesystem store — no AI clients.
 * @param {{ getDataLogDir: () => string }} deps - Injects the data/log directory resolver so the hosted-images store sits alongside the logs.
 * @returns {{ getHostedImagesDir: () => string, getHostedImagesManifestPath: () => string, readHostedImagesManifest: () => import('../types/image.js').HostedImageEntry[], writeHostedImagesManifest: (arr: import('../types/image.js').HostedImageEntry[]) => boolean }} The persistent hosted-image manifest store API.
 */
export function createHostedImages({ getDataLogDir }) {
  /**
   * Resolve the hosted-images directory, creating it (recursive) if missing.
   * On mkdir failure it logs an error but still returns the path.
   * @returns {string} Absolute path to `<dataLogDir>/hosted-images`.
   */
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

  /**
   * Resolve the manifest file path (also ensures the directory exists via
   * getHostedImagesDir).
   * @returns {string} Absolute path to the manifest file `<hosted-images dir>/index.json`.
   */
  function getHostedImagesManifestPath() {
    return path.join(getHostedImagesDir(), 'index.json');
  }

  /**
   * Read and parse the hosted-images manifest, failing open to [] on a missing
   * file, unparseable JSON, or a non-array payload; read errors are logged.
   * @returns {import('../types/image.js').HostedImageEntry[]} Parsed manifest array of hosted-image entries, or [] when absent/invalid.
   */
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

  /**
   * Overwrite index.json wholesale with the given manifest array (pretty-printed
   * JSON); logs and returns false on error.
   * @param {import('../types/image.js').HostedImageEntry[]} arr - The full manifest array to persist (pretty-printed as JSON).
   * @returns {boolean} true on successful write, false if the write threw.
   */
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
