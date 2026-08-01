// Shared JSDoc/TS shapes for listing projects (lib/data/projects.js and the routes
// that will sit on top of it).
// Type-check only. Reference from .js with e.g.
//   /** @param {import('../types/projects.js').Project} project */
// PERMISSIVE by design — see note in chat.d.ts: these describe rows read back out of
// SQLite, where the driver hands us `any`, so the value of the names here is
// documentation and call-site autocomplete rather than enforcement.

/** `projects.status`. Mirrors the CHECK constraint in projects.js. */
export type ProjectStatus = 'draft' | 'staging' | 'ready' | 'archived';

/**
 * `project_photos.frame_role`. 'hero' is the one frame per room that the design
 * bible is authored from; 'support' frames are staged to match it; 'excluded' frames
 * are kept in the shoot but never staged.
 */
export type FrameRole = 'hero' | 'support' | 'excluded';

/** `renders.status`. 'superseded' is a previously-ok render that a newer bible retired. */
export type RenderStatus = 'queued' | 'running' | 'ok' | 'failed' | 'superseded';

/** One listing — the container every photo, bible and render hangs off. */
export interface Project {
  id: string;
  userId: string;
  title: string;
  address: string;
  status: ProjectStatus;
  /** Epoch ms. */
  createdAt: number;
  /** Epoch ms; bumped by every write that changes what the listing looks like. */
  updatedAt: number;
  /** Parsed `extra_json`, or null when absent/unparseable. */
  extra: Record<string, unknown> | null;
}

/** One uploaded source photo. */
export interface ProjectPhoto {
  id: string;
  projectId: string;
  /** Relative, backend-agnostic key into lib/data/project-storage.js. */
  storageKey: string;
  /** Display/processing order within the project. */
  seq: number;
  /** Which room this frame belongs to; null until the photo has been grouped. */
  roomKey: string | null;
  roomType: string | null;
  frameRole: FrameRole;
  width: number | null;
  height: number | null;
  /** Human aspect-ratio label, e.g. '3:2', as shown in the studio. */
  arLabel: string | null;
  /** null = not yet checked; true/false = the /api/validate-image verdict. */
  stageable: boolean | null;
  /** Rejection category from lib/staging/unstageable.js when stageable is false. */
  unstageableCode: string | null;
  /** Content hash — the dedup key within a project. */
  sha256: string;
  createdAt: number;
}

/**
 * One `design_bibles` ROW. The authored document itself is `doc` (a `DesignBible`);
 * this is the row it is versioned and stored in.
 */
export interface DesignBibleRow {
  id: string;
  projectId: string;
  roomKey: string;
  /** 1-based, auto-incremented per (projectId, roomKey). */
  version: number;
  /** The render the bible was authored from, when there was one. */
  heroRenderId: string | null;
  /** Parsed `doc_json`, or null when it could not be parsed. */
  doc: DesignBible | null;
  furnitureStyle: string;
  roomType: string;
  createdAt: number;
}

/** One render attempt for one photo. */
export interface Render {
  id: string;
  projectId: string;
  photoId: string;
  /** The bible this render must match; null on a hero frame (it defines the bible). */
  bibleId: string | null;
  /** 1-based variation index for the same photo. */
  variation: number;
  /** Relative storage key; null until the render succeeds. */
  storageKey: string | null;
  status: RenderStatus;
  promptText: string | null;
  model: string | null;
  genAttempts: number;
  qualityScore: number | null;
  consistencyScore: number | null;
  errorCode: string | null;
  durationMs: number | null;
  /** Epoch ms the worker took the lease; null while queued. */
  claimedAt: number | null;
  createdAt: number;
  extra: Record<string, unknown> | null;
}

/**
 * What a share link publishes ALONGSIDE the photos. Every field here is visible to
 * anyone holding the link, so the store normalizes it through an allowlist rather
 * than storing whatever the owner sent.
 */
export interface ShareSettings {
  /** Whether the original photo is served next to the staged one. Defaults true. */
  showBefore: boolean;
  /** Optional replacement for the listing title at the top of the page. */
  headline: string;
  /** Optional paragraph from the agent to their client. */
  note: string;
  agentName: string;
  agentEmail: string;
  agentPhone: string;
}

/**
 * One share link. The token itself is NOT here and never leaves `createShare` —
 * only its digest is stored (lib/data/project-shares.js).
 */
export interface ProjectShare {
  id: string;
  projectId: string;
  /** Denormalized owner; what makes this table visible to the erasure drift guard. */
  userId: string;
  createdAt: number;
  /** Epoch ms, or null for a link that does not expire. */
  expiresAt: number | null;
  /** Epoch ms the owner disabled it; null while live. */
  revokedAt: number | null;
  viewCount: number;
  lastViewedAt: number | null;
  settings: ShareSettings;
}

/** What a share viewer answered. Rows are append-only; the latest per room wins. */
export type FeedbackVerdict = 'approved' | 'changes';

/**
 * One response from someone holding a share link — the seller's sign-off, or their
 * request for a change, attached to the room it is about.
 */
export interface ShareFeedback {
  id: string;
  shareId: string;
  projectId: string;
  /** Denormalized LISTING OWNER — not the viewer, who is never identified. */
  userId: string;
  /** null when the response is about the whole listing rather than one room. */
  roomKey: string | null;
  verdict: FeedbackVerdict;
  /** Free text, clamped and whitespace-collapsed by the store. */
  note: string;
  /** Optional display name the viewer typed. Never required. */
  viewerLabel: string;
  createdAt: number;
}

/** One staged frame as the PUBLIC gallery sees it — ids only, no internals. */
export interface SharedFrame {
  /** Opaque id for `GET /api/share/:token/render/:id`. */
  renderId: string;
  /** Present only when the share publishes before/after. */
  photoId: string | null;
  width: number | null;
  height: number | null;
  arLabel: string | null;
}

/** One room's frames in the public gallery. */
export interface SharedRoom {
  /** Stable grouping key; opaque to the viewer. */
  key: string;
  /** Human label, e.g. 'Living room'. */
  label: string;
  frames: SharedFrame[];
}

/**
 * The whole payload `GET /api/share/:token` answers with. Deliberately NOT a
 * projection of `Project` — it is built field by field so a column added upstream
 * cannot appear on a public URL by default.
 */
export interface SharedListing {
  title: string;
  address: string;
  headline: string;
  note: string;
  showBefore: boolean;
  agent: { name: string; email: string; phone: string };
  rooms: SharedRoom[];
  /** Count of staged frames, for the header. */
  frameCount: number;
  /** The virtual-staging disclosure this page is required to carry. */
  disclosure: string;
}

/**
 * One piece of furniture (or fixture) the bible pins down, so the same sofa appears
 * in every frame of the room rather than a different sofa per render.
 */
export interface BiblePiece {
  /** 'sofa' | 'rug' | … — the join key the consistency reviewer scores per-item. */
  slot: string;
  /** Reproducible description: leg count/material, cushion count, pile height… */
  identity: string;
  placement: string;
  /** Only critical slots gate a retry. */
  critical: boolean;
}

/**
 * The design bible document: everything a support frame needs in order to be staged
 * consistently with its room's hero frame. Stored as `doc_json` on a `DesignBibleRow`.
 */
export interface DesignBible {
  version: number;
  roomKey: string;
  roomType: string;
  furnitureStyle: string;
  palette: Record<string, string>;
  lighting: Record<string, string>;
  pieces: BiblePiece[];
  negatives: string[];
}
