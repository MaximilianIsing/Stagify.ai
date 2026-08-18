// Shared JSDoc/TS shapes for the GROUPED router dependencies (server.js).
// Type-check only — no runtime effect. Reference from .js files with e.g.
//   /** @param {{ email: import('../types/deps.js').EmailDeps }} deps */
// (`import('...deps.js')` resolves to this .d.ts under NodeNext.)
//
// PERMISSIVE by design — see the note in chat.d.ts.
//
// WHY ONLY SOME DEPS ARE GROUPED
// ------------------------------
// server.js builds cohesive factories and used to destructure them into loose
// names before re-flattening those into each router's dependency bag. The groups
// below undo that for the factories whose consumers are confined to the routers
// that do NOT forward their bag onward.
//
// `routes/admin.js`, `routes/auth.js` and `routes/public.js` consume `deps`
// themselves and forward nothing, so grouping is a local change. `routes/chat.js`
// and `routes/staging.js` pass the WHOLE bag to sub-factories
// (createChatPipeline, createMaskEditHandler, …), each of which destructures its
// own slice — so grouping a name they read means changing every one of those too.
// That is why `logging`, `memories` and the image primitives are deliberately
// still flat. Do not "finish the job" without reading
// docs/guides/architecture.md first.

/**
 * The `createEmail()` surface as consumed by the auth and public routers.
 *
 * `forgetEmailOpenState` is intentionally ABSENT: it is a createUserDeletion
 * factory input, not part of any router's surface, and server.js pulls it back
 * out of the group for that single use.
 */
export interface EmailDeps {
  logEmailOpenToFile: (email: string, req: any) => void;
  isConfirmedEmailClientOpen: (req: any) => boolean;
  sendRegistrationVerificationEmail: (args: { toEmail: string; code: string }) => Promise<any>;
  sendAccountExistsNotice: (args: { toEmail: string }) => Promise<any>;
}

/**
 * The `createHostedImages()` surface — the admin-managed public image store on
 * the persistent disk, plus its JSON manifest. The admin router reads all three;
 * the public router only reads the two getters.
 */
export interface HostedImagesDeps {
  getHostedImagesDir: () => string;
  readHostedImagesManifest: () => any;
  writeHostedImagesManifest: (manifest: any) => void;
}
