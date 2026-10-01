// The router factory every routes/*.js file builds on.
//
// On Express 4 this wrapped each terminal handler so an async rejection reached next(err)
// instead of hanging the request. Express 5 forwards a rejected promise from a handler to
// the error pipeline natively, so the wrapper is gone and this is now a plain
// express.Router(). The name stays as the one seam all routers share, and
// test/http/async-router.test.js pins the native behavior so a regression still fails CI.
import express from 'express';

export function createAsyncRouter(...routerArgs) {
  return express.Router(...routerArgs);
}
