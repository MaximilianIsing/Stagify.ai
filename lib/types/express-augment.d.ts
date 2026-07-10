// Ambient type augmentation for Express `Request`. Type-check only — no runtime effect.
// Declares the custom properties this server hangs off the request object so `checkJs`
// recognises them instead of flagging TS2339. Add new per-request custom fields here.
import 'express';

declare global {
  namespace Express {
    interface Request {
      // Count of billable staging generations accumulated across a single request's
      // variations + quality-gate retries (server.js). Metered for enterprise usage.
      _stagingGenerations?: number;
    }
  }
}
