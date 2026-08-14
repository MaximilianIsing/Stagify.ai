// Step 4: crop both frames to 4:5, identically.
//
// Two reasons, and the second one is the important one.
//
// Presentation: the lower left corner of the room is a pile up of chrome brush stand,
// toilet rim and the internal corner of two walls, and the model left a thin sliver of the
// original marble beside the stand where it declined to tile right up to the brush edge.
// It is small, it is real, and it reads as the tool missing a bit, which is the one thing
// this post cannot afford to look like. Out of frame it costs nothing.
//
// Honesty: the before and after MUST be cropped by the same rectangle. The whole argument
// is that the two frames differ in exactly one place, and a viewer flicking between two
// slides reads any shift of the crop as a change in the room. Cropping them separately, or
// letting the template's background-size:cover crop each one to its own card, would put a
// difference in the post that the product did not make.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const source = JSON.parse(fs.readFileSync(path.join(HERE, 'source.json'), 'utf8'));

const edited = path.join(HERE, 'edited.png');
const { width: EW, height: EH } = await sharp(edited).metadata();

// Cropped to the photo card's OWN aspect ratio, 968 by 748, which is 1.294.
//
// This is not a taste decision. The card sets background-size:cover, so it crops whatever
// it is given to its own shape, and a portrait frame handed to a landscape card loses a
// third of its height to a crop chosen by CSS rather than by anyone looking at it. Doing
// the crop here means the pin percentages in post.json address the picture directly, and
// what was measured is what appears.
//
// Full width, and the vertical window keeps the wall from well above the tap down through
// the bath rim, which is the part of the room the post is about.
// Narrower than the frame on purpose. The far right of this room is a strip of wall between
// the tub and the corner where three things go wrong at once: the bath's flank turns too
// steeply for a per-column edge to follow, the wall-to-floor junction is a soft gradient with
// no line to find, and everything there sits in deep shadow. Three separate mask attempts
// each left either a pale wedge or green spilling onto the floor. It is a corner worth
// losing: cropping before it costs a little of the tub, which reads as an ordinary framing
// choice, and removes the whole class of defect.
const box = { left: 0, top: 254, width: 655, height: 506 };

// The "before" is the pipeline's own normalised source, written by edit.js, NOT the
// original upload resized to match. This line used to say sharp(source.path).resize(...),
// which is the same size and not the same bytes: an image reviewer measured the finished
// carousel shifting one pixel across the vanity and two across the mirror, which made the
// legend's "the same pixels" false in every region rather than none of them.
const beforeFull = fs.readFileSync(path.join(HERE, 'before-full.png'));

const out = {};
for (const [role, input] of [['before', beforeFull], ['after', fs.readFileSync(edited)]]) {
  const file = path.join(HERE, `${role}-crop.png`);
  await sharp(input).extract(box).png().toFile(file);
  await sharp(file).resize(700).jpeg({ quality: 90 })
    .toFile(path.join(HERE, `preview-${role}-crop.jpg`));
  out[role] = file;
}

const meta = await sharp(out.before).metadata();
console.log(`box     ${JSON.stringify(box)}`);
console.log(`size    ${meta.width}x${meta.height}  (${(meta.width / meta.height).toFixed(3)}, 4:5 is 0.800)`);
console.log(`wrote   before-crop.png, after-crop.png`);
