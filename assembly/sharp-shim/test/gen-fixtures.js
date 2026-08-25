'use strict';
/* Generates deterministic fixtures for the sharp-shim test suite. */
const fs = require('fs');
const path = require('path');
const jpegjs = require('../vendor/jpeg-js/index.js');
const pngjs = require('../vendor/pngjs/lib/png.js');
const { GifWriter } = require('../vendor/omggif/omggif.js');

const OUT = path.join(__dirname, 'fixtures');
fs.mkdirSync(OUT, { recursive: true });

function fillBuffer(width, height, fillFn) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const c = fillFn(x, y);
      data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = c.length > 3 ? c[3] : 255;
    }
  }
  return data;
}

function report(name, bytes) {
  console.log(`fixture ${name}: ${(bytes / 1024).toFixed(1)} KB`);
}

/* 1. Photo-like JPEG: smooth gradients + soft blobs -> many colours. */
{
  const w = 900, h = 600;
  const blobs = [[200, 180, 140, [220, 60, 60]], [650, 420, 190, [50, 80, 210]], [480, 150, 110, [250, 210, 60]]];
  const data = fillBuffer(w, h, (x, y) => {
    let r = 30 + ((x * 255) / w) | 0;
    let g = 40 + ((y * 235) / h) | 0;
    let b = 90 + (((x + y) * 100) / (w + h)) | 0;
    for (const [bx, by, br, col] of blobs) {
      const d = Math.hypot(x - bx, y - by);
      if (d < br) {
        const t = Math.pow(1 - d / br, 1.6);
        r = r * (1 - t) + col[0] * t;
        g = g * (1 - t) + col[1] * t;
        b = b * (1 - t) + col[2] * t;
      }
    }
    return [r | 0, g | 0, b | 0];
  });
  const out = jpegjs.encode({ data, width: w, height: h }, 88);
  fs.writeFileSync(path.join(OUT, 'photo.jpg'), out.data);
  report('photo.jpg', out.data.length);
}

/* 2. Flat-colour UI screenshot PNG, colourType 2 (no alpha plane). */
{
  const w = 720, h = 1280;
  const data = fillBuffer(w, h, (x, y) => {
    if (y < 96) return x % 3 === 0 ? [76, 175, 80] : [67, 160, 71];
    if (y > 1180) return [33, 33, 33];
    if (x > 24 && x < 696 && y > 140 && y < 400 && (y - 140) % 56 < 30) return [255, 255, 255];
    return [242, 242, 242];
  });
  const png = new pngjs.PNG({ width: w, height: h });
  Buffer.from(png.data.buffer, png.data.byteOffset, png.data.byteLength).set(data);
  const bytes = pngjs.PNG.sync.write(png, { colorType: 2, inputHasAlpha: true, deflateLevel: 9 });
  fs.writeFileSync(path.join(OUT, 'screenshot-rgb.png'), bytes);
  report('screenshot-rgb.png', bytes.length);
}

/* 3. RGBA PNG whose alpha plane is fully opaque (the trap: presence != usage). */
{
  const w = 720, h = 1280;
  const data = fillBuffer(w, h, (x, y) => {
    if (y < 96) return [76, 175, 80];
    if ((x + y) % 97 < 40) return [255, 255, 255];
    return [242, 242, 242];
  });
  const png = new pngjs.PNG({ width: w, height: h });
  Buffer.from(png.data.buffer, png.data.byteOffset, png.data.byteLength).set(data);
  const bytes = pngjs.PNG.sync.write(png, { colorType: 6, inputHasAlpha: true, deflateLevel: 9 });
  fs.writeFileSync(path.join(OUT, 'rgba-opaque.png'), bytes);
  report('rgba-opaque.png', bytes.length);
}

/* 4. Flat colours + real transparency -> lowColour + alpha path. */
{
  const w = 600, h = 800;
  const data = fillBuffer(w, h, (x, y) => {
    if (Math.hypot(x - 300, y - 400) > 260) return [0, 0, 0, 0];
    if (y < 260) return [98, 0, 238];
    if ((x >> 4) % 2 === 0) return [255, 255, 255];
    return [230, 230, 240];
  });
  const png = new pngjs.PNG({ width: w, height: h });
  Buffer.from(png.data.buffer, png.data.byteOffset, png.data.byteLength).set(data);
  const bytes = pngjs.PNG.sync.write(png, { colorType: 6, inputHasAlpha: true, deflateLevel: 9 });
  fs.writeFileSync(path.join(OUT, 'rgba-transparent-ui.png'), bytes);
  report('rgba-transparent-ui.png', bytes.length);
}

/* 5. Noise + transparency -> non-lowColour alpha -> webp-only dead end. */
{
  let seed = 123456789;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const w = 700, h = 700;
  const data = fillBuffer(w, h, (x, y) => {
    if (y < 60 || y > 640) return [0, 0, 0, 0];
    return [(rand() * 256) | 0, (rand() * 256) | 0, (rand() * 256) | 0];
  });
  const png = new pngjs.PNG({ width: w, height: h });
  Buffer.from(png.data.buffer, png.data.byteOffset, png.data.byteLength).set(data);
  const bytes = pngjs.PNG.sync.write(png, { colorType: 6, inputHasAlpha: true, deflateLevel: 9 });
  fs.writeFileSync(path.join(OUT, 'rgba-transparent-noise.png'), bytes);
  report('rgba-transparent-noise.png', bytes.length);
}

/* 6. Pure RGB noise -> heavy shrink loop under tight byte caps. */
{
  let seed = 987654321;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const w = 1400, h = 1000;
  const data = fillBuffer(w, h, () => [(rand() * 256) | 0, (rand() * 256) | 0, (rand() * 256) | 0]);
  const png = new pngjs.PNG({ width: w, height: h });
  Buffer.from(png.data.buffer, png.data.byteOffset, png.data.byteLength).set(data);
  const bytes = pngjs.PNG.sync.write(png, { colorType: 2, inputHasAlpha: true, deflateLevel: 6 });
  fs.writeFileSync(path.join(OUT, 'noise.png'), bytes);
  report('noise.png', bytes.length);
}

/* 7+8. Static and animated GIFs through GifWriter (palette padded to pow2). */
function writeGif(name, width, height, frames, colors) {
  // GifWriter wants ONE PACKED 24-BIT INT per colour (length = colour count,
  // a power of two within 2..256).
  const flat = colors.map((c) => (c[0] << 16) | (c[1] << 8) | c[2]);
  const pow2 = 1 << Math.ceil(Math.log2(colors.length));
  while (flat.length < pow2) flat.push(0);
  const size = width * height * frames.length + 4096 + flat.length * 3;
  const buf = new Uint8Array(size);
  const gf = new GifWriter(buf, width, height, { palette: flat, loop: frames.length > 1 ? 0 : undefined });
  frames.forEach((idx, i) => gf.addFrame(0, 0, width, height, idx, frames.length > 1 ? { delay: 10 } : {}));
  const end = gf.end();
  fs.writeFileSync(path.join(OUT, name), Buffer.from(buf.subarray(0, end)));
  report(name, end);
}
{
  const w = 320, h = 240;
  const colors = [
    [24, 24, 24], [240, 240, 240], [200, 60, 60], [60, 160, 90],
    [70, 110, 220], [240, 200, 70], [150, 150, 150], [255, 128, 0],
  ];
  const frameA = new Uint8Array(w * h);
  const frameB = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      frameA[i] = (Math.floor(x / 40) + Math.floor(y / 40)) % 2 ? 1 : 0;
      frameB[i] = x < w / 2 ? (y < h / 2 ? 2 : 3) : (y < h / 2 ? 4 : 5);
    }
  }
  writeGif('static.gif', w, h, [frameA], colors);
  writeGif('animated.gif', w, h, [frameA, frameB], colors);
}

/* 9. JPEG with injected EXIF orientation 6 (rot90 CW), asymmetric quadrants. */
{
  const w = 8, h = 6;
  const data = fillBuffer(w, h, (x, y) => {
    const left = x < w / 2, top = y < h / 2;
    if (top && left) return [220, 20, 20];     // TL red
    if (top && !left) return [20, 220, 20];    // TR green
    if (!top && left) return [20, 20, 220];    // BL blue
    return [245, 245, 245];                    // BR white
  });
  const base = jpegjs.encode({ data, width: w, height: h }, 96).data;
  const tiff = Buffer.alloc(26);
  tiff.write('II', 0, 'ascii');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);        // first IFD at 8
  tiff.writeUInt16LE(1, 8);        // one entry
  tiff.writeUInt16LE(0x0112, 10);  // Orientation tag
  tiff.writeUInt16LE(3, 12);       // SHORT
  tiff.writeUInt32LE(1, 14);       // count
  tiff.writeUInt16LE(6, 18);       // value: 6 = rotate 90 CW
  tiff.writeUInt32LE(0, 20);       // padding + next IFD = 0
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1 = Buffer.alloc(payload.length + 4);
  app1[0] = 0xFF; app1[1] = 0xE1;
  app1.writeUInt16BE(payload.length + 2, 2);
  payload.copy(app1, 4);
  const spliced = Buffer.concat([base.subarray(0, 2), app1, base.subarray(2)]);
  fs.writeFileSync(path.join(OUT, 'exif6.jpg'), spliced);
  report('exif6.jpg', spliced.length);
}

/* 10. A real Windows JPEG when available (camera/photo realism). */
{
  const candidates = [];
  const roots = ['C:/Windows/Web/Wallpaper/Windows', 'C:/Windows/Web/4K/Wallpaper/Windows', 'C:/Windows/Web/Wallpaper'];
  for (const root of roots) {
    try {
      for (const f of fs.readdirSync(root)) {
        if (f.toLowerCase().endsWith('.jpg')) candidates.push(path.join(root, f));
      }
    } catch (e) { /* root missing */ }
  }
  if (candidates.length > 0) {
    const src = candidates[0];
    fs.copyFileSync(src, path.join(OUT, 'real-photo.jpg'));
    report(`real-photo.jpg (${path.basename(src)})`, fs.statSync(src).size);
  } else {
    console.log('fixture real-photo.jpg: SKIPPED (no Windows wallpapers found)');
  }
}

console.log('fixtures done -> ' + OUT);
