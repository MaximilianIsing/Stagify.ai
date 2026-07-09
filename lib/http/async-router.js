// Async-safe Express Router.
//
// Express 4 does NOT forward a rejected promise from an `async` route handler to
// error-handling middleware — the rejection surfaces as an unhandledRejection and
// the request hangs (no response) until the socket times out. Every handler in
// routes/*.js currently wraps its body in try/catch, but a single future omission
// would silently reintroduce that failure mode.
//
// createAsyncRouter() returns an ordinary express.Router() whose HTTP-verb methods
// auto-wrap the terminal handler so any escaped rejection is routed to next(err),
// where the app's catch-all error handler (server.js) turns it into a clean 500.
// Preceding middleware (rate limiters, multer, body parsers, the synchronous auth
// guards) is passed through untouched — only the last function argument, i.e. the
// route handler, is wrapped.
//
// Note on synchronous throws: an async handler that throws before its first await
// still returns a rejected promise (it does not throw synchronously), so .catch
// covers it. A plain synchronous handler that throws is already caught by Express
// itself and forwarded to the error pipeline, so it needs no wrapping here.
import express from 'express';

const VERBS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all'];

// Funnel a handler's async rejection into Express's error pipeline via next(err).
export const asyncHandler = (fn) =>
  function asyncHandlerWrapped(req, res, next) {
    return Promise.resolve(fn(req, res, next)).catch(next);
  };

export function createAsyncRouter(...routerArgs) {
  const router = express.Router(...routerArgs);
  for (const verb of VERBS) {
    const register = router[verb].bind(router);
    router[verb] = (path, ...handlers) => {
      const lastIdx = handlers.length - 1;
      const wrapped = handlers.map((h, i) =>
        i === lastIdx && typeof h === 'function' ? asyncHandler(h) : h,
      );
      return register(path, ...wrapped);
    };
  }
  return router;
}
