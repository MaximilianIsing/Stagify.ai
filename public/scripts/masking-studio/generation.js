// Pure helpers backing the Masking Studio's parallel mask-edit flow: region
// naming, cross-area prompt context, and request-error mapping.
//
// No DOM, no module state (see test/masking-studio-generation.test.js). The
// entry does the canvas pixel work — scanning a layer's alpha for its bounding
// box, POSTing to /api/mask-edit — and hands the plain results in here.

// Rough position of a mask inside the photo ("lower left", "center"…) from the
// bounding box of its painted pixels on a `size`×`size` scan. `maxX < 0` means
// nothing was painted, so there is no region. The entry computes the bounds by
// scanning the layer canvas; the classification is pure and lives here.
export function regionNameFromBounds(minX, minY, maxX, maxY, size) {
  if (maxX < 0) return '';
  const cx = (minX + maxX) / 2 / size;
  const cy = (minY + maxY) / 2 / size;
  const col = cx < 1 / 3 ? 'left' : (cx > 2 / 3 ? 'right' : 'center');
  const row = cy < 1 / 3 ? 'upper' : (cy > 2 / 3 ? 'lower' : 'middle');
  if (row === 'middle' && col === 'center') return 'center';
  if (row === 'middle') return 'center ' + col;
  if (col === 'center') return row + ' middle';
  return row + ' ' + col;
}

// Areas generate in parallel and never see each other's output, so each prompt
// carries a sketch of the neighbors' plans — enough for the model to keep
// lighting, perspective, and style coherent across areas. `resolveRegion(layer)`
// yields the region phrase (the entry wires it to a canvas scan); returns '' when
// no other painted area exists.
export function buildAreaContext(layer, participants, resolveRegion) {
  const others = participants.filter((l) => l !== layer && l.painted);
  if (!others.length) return '';
  const plans = others.map((l) => {
    let plan;
    if (l.mode === 'remove') plan = 'the existing contents are being removed';
    else if (l.prompt.trim()) plan = l.prompt.trim();
    else plan = 'furniture from a reference photo is being added';
    if (plan.length > 90) plan = plan.slice(0, 87) + '…';
    const region = resolveRegion(l);
    return (region ? 'in the ' + region + ' of the photo: ' : '') + plan;
  });
  return ' For context, other parts of this photo are being edited separately (' +
    plans.join('; ') +
    '). Only edit the masked area, but keep lighting, shadows, perspective, and furnishing style consistent with those planned changes.';
}

// Maps a failed request (status + parsed JSON body) to a user-facing message.
// 401/403 also means the plan lapsed mid-session, so `onGate()` re-reveals the
// upgrade dialog. `translate(key, fallback)` localizes each message.
export function requestError(status, result, translate, onGate) {
  if (status === 401 || status === 403) {
    if (onGate) onGate();
    return translate('maskingStudio.gateTitle', 'Masking Studio is a Stagify+ feature');
  }
  if (status === 429) return translate('maskingStudio.rateLimited', "You're generating too quickly — wait a minute and try again.");
  if (status === 413) return translate('errors.fileTooLarge', 'That image is too large.');
  return (result && result.error) || translate('errors.processingFailed', 'Something went wrong. Please try again.');
}
