// Pure response-assembly helpers for the AI Designer dispatch pipeline
// (lib/chat/chat-pipeline.js). Both functions are pure over their arguments —
// no deps bundle, no DEBUG_MODE, no logger — so they are independently
// unit-testable by importing the exports directly.

// Await every result's annotationPromise and collect the non-null ones into
// a { `${prefix}_${i}`: annotation } map. Replaces 6 identical inline loops.
export async function awaitAnnotations(results, prefix) {
  const out = {};
  for (let i = 0; i < results.length; i++) {
    if (results[i].annotationPromise) {
      const annotation = await results[i].annotationPromise;
      if (annotation) out[`${prefix}_${i}`] = annotation;
    }
  }
  return out;
}

// Assemble the JSON response body from all dispatch results, awaiting the
// image annotations. `extraFields` are top-level fields inserted right after
// `response` (e.g. { files } for the upload endpoint); `imageAnnotations` is
// the upload endpoint's per-upload annotation map.
export async function buildDesignerResponse({
  text,
  memoryActions,
  stagingResults,
  generatedImages,
  requestedImageForDisplay,
  recalledImageForDisplay,
  cadResults,
  extraFields = {},
  imageAnnotations = null,
}) {
  /** @type {Record<string, any>} */
  const response = {
    response: text,
    ...extraFields,
    memories: memoryActions
  };

  // Handle multiple staging results
  const stagedImageAnnotations = await awaitAnnotations(stagingResults, 'staged');
  if (stagingResults.length > 0) {
    if (stagingResults.length === 1) {
      // Single result - maintain backward compatibility
      response.stagedImage = stagingResults[0].stagedImage;
      response.stagingParams = stagingResults[0].params;
    } else {
      // Multiple results - return as array
      response.stagedImages = stagingResults.map(r => r.stagedImage);
      response.stagingParams = stagingResults.map(r => r.params);
    }
    // Include annotations if available
    if (Object.keys(stagedImageAnnotations).length > 0) {
      response.stagedImageAnnotations = stagedImageAnnotations;
    }
  }

  // Handle multiple generated images
  const generatedImageAnnotations = await awaitAnnotations(generatedImages, 'generated');
  if (generatedImages.length > 0) {
    if (generatedImages.length === 1) {
      // Single result - maintain backward compatibility
      response.generatedImage = generatedImages[0].image || generatedImages[0];
    } else {
      // Multiple results - return as array
      response.generatedImages = generatedImages.map(g => g.image || g);
    }
    // Include annotations if available
    if (Object.keys(generatedImageAnnotations).length > 0) {
      response.generatedImageAnnotations = generatedImageAnnotations;
    }
  }

  if (requestedImageForDisplay) {
    response.requestedImage = requestedImageForDisplay;
  }

  if (recalledImageForDisplay) {
    response.recalledImage = recalledImageForDisplay;
  }

  // Handle multiple CAD results
  const cadImageAnnotations = await awaitAnnotations(cadResults, 'cad');
  if (cadResults.length > 0) {
    if (cadResults.length === 1) {
      // Single result - maintain backward compatibility
      response.cadImage = cadResults[0].cadImage;
      const cadImageAnnotation = cadResults[0].annotationPromise ? await cadResults[0].annotationPromise : null;
      if (cadImageAnnotation) {
        response.cadImageAnnotation = cadImageAnnotation;
      }
    } else {
      // Multiple results - return as array
      response.cadImages = cadResults.map(r => r.cadImage);
      response.cadParams = cadResults.map(r => r.params);
    }
    // Include annotations if available
    if (Object.keys(cadImageAnnotations).length > 0) {
      response.cadImageAnnotations = cadImageAnnotations;
    }
  }

  if (imageAnnotations && Object.keys(imageAnnotations).length > 0) {
    response.imageAnnotations = imageAnnotations;
  }

  return response;
}
