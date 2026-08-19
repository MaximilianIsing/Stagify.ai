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
      // True when at least one image in this request was accepted WITHOUT a quality
      // review (reviewer disabled or throwing). Recorded in the render log so a
      // silent reviewer outage is visible instead of reading as a flawless run.
      _qaDegraded?: boolean;
      // Set by lib/http/api-key-auth.js on every authenticated /api/v1 request: the
      // API key that was presented, and the account it belongs to. Nothing downstream
      // may read an owner from the request BODY — these are the validated values.
      apiKey?: { id: string; userId: string; prefix: string };
      apiUser?: any;
    }
  }
}
