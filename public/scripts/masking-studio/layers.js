// Pure area-layer / concurrency helpers for the Masking Studio.
//
// No DOM, no module state — inputs come in as parameters, so these run under
// node --test with no shim (see test/masking-studio-layers.test.js). The browser
// entry keeps the DOM-bound layer bookkeeping and passes its `layers` array in.

// Bounded-concurrency promise pool: at most `size` jobs run at once, the rest
// queue. Returns an enqueue(fn) that resolves/rejects with fn()'s result. Used
// to cap in-flight /api/mask-edit calls (smoother on rate limits than firing
// every area at once) while progressive compositing keeps the wait short.
export function createPool(size) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (!queue.length || active >= size) return;
    active++;
    const job = queue.shift();
    job.fn().then(job.resolve, job.reject).then(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn: fn, resolve: resolve, reject: reject });
    next();
  });
}

// Lowest palette index not yet claimed by an existing layer, or -1 when the
// palette is exhausted (all `paletteLength` colors are in use).
export function nextColorIdx(layers, paletteLength) {
  for (let i = 0; i < paletteLength; i++) {
    if (!layers.some((l) => l.colorIdx === i)) return i;
  }
  return -1;
}
