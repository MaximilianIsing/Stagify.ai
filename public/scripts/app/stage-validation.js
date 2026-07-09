// Stageability pre-check for the main Stagify tool (scripts/app.js).
//
// Plain exported fetch helper — no DOM wiring, no app state. The entry owns
// the stageValidation/stageValidationResult bookkeeping around it; this module
// only asks the server whether an uploaded photo is a stageable space.

// Downscale a data URL to a small JPEG (keeps the POST body well under the
// server's 50MB JSON cap and saves tokens), then ask the server whether it is
// a stageable space. Always resolves to { valid, reason }; never rejects.
export function validateStageableUpload(dataUrl) {
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = async () => {
          let payload = dataUrl;
          try {
            // 512px matches the server's low-detail vision tile — bigger would
            // only be downsampled away, so this keeps the upload small and fast.
            const max = 512;
            const scale = Math.min(1, max / Math.max(img.width, img.height));
            const c = document.createElement('canvas');
            c.width = Math.max(1, Math.round(img.width * scale));
            c.height = Math.max(1, Math.round(img.height * scale));
            c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
            payload = c.toDataURL('image/jpeg', 0.9);
          } catch (e) { /* fall back to the original data URL */ }
          try {
            const tok = window.StagifyAuth && window.StagifyAuth.getToken();
            const resp = await fetch('/api/validate-image', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(tok ? { Authorization: 'Bearer ' + tok } : {}),
              },
              body: JSON.stringify({ image: payload, authToken: tok || undefined }),
            });
            if (!resp.ok) return resolve({ valid: true, reason: '' });
            const r = await resp.json().catch(() => null);
            if (!r || typeof r.valid !== 'boolean') return resolve({ valid: true, reason: '' });
            resolve(r);
          } catch (e) {
            resolve({ valid: true, reason: '' });
          }
        };
        img.onerror = () => resolve({ valid: true, reason: '' });
        img.src = dataUrl;
      });
}
