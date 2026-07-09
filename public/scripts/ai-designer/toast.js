// Toast notifications for the AI Designer chat UI (plain export, not a
// factory — no state). Self-creates the #toast-host container on first use.
// Lifted verbatim from the entry (scripts/ai-designer-app.js).

      // Non-blocking toast notification (replaces native alert()).
      export function showToast(message, type) {
        let host = document.getElementById('toast-host');
        if (!host) {
          host = document.createElement('div');
          host.id = 'toast-host';
          host.setAttribute('aria-live', 'polite');
          document.body.appendChild(host);
        }
        const toast = document.createElement('div');
        toast.className = 'toast' + (type ? ' toast--' + type : '');
        toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
        toast.textContent = message;
        host.appendChild(toast);
        requestAnimationFrame(() => toast.classList.add('toast--show'));
        setTimeout(() => {
          toast.classList.remove('toast--show');
          setTimeout(() => toast.remove(), 320);
        }, 4200);
      }
