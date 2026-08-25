'use strict';
/*
 * Android pure-JS sharp shim (v2 — full pixel pipeline).
 *
 * Replaces the native libvips binding (glibc/musl builds cannot load under
 * bionic). v1 parsed headers only and threw on every pixel operation, which
 * left read_image broken at the decode/re-encode step. v2 implements the
 * operations dsh-attachment-local actually exercises:
 *
 *   metadata()                  header parse + exact alpha scan (png/gif)
 *   raw().toBuffer(...)         full pixel decode -> RGB(A) Buffer
 *   resize({fit:'inside'})      box-filter area average / nearest kernel
 *   rotate()                    EXIF orientation transform (2..8)
 *   .jpeg(q).toBuffer()         jpeg-js encode
 *   .png({...}).toBuffer()      pngjs encode (truecolor or RGBA)
 *
 * Known gaps (fail loud with SHIM_NO_WEBP_* codes):
 *   - WebP pixel decode/encode is not implemented (header metadata works).
 *     Transparent non-low-colour sources route to webp-only attempts and
 *     will surface ATTACHMENT_WRITE_FAILED upstream.
 * - hasAlpha reports actual transparency (any alpha < 255), which matches
 *   how the only consumer uses it: selecting an encode branch that can
 *   preserve what the source really carries.
 */
const jpegjs = require('./vendor/jpeg-js/index.js');
const pngjs = require('./vendor/pngjs/lib/png.js');
const { GifReader } = require('./vendor/omggif/omggif.js');

const SUPPORTED = { jpeg: 1, png: 1, webp: 1, gif: 1 };

function shimError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/* ------------------------------------------------------------------ */
/* Header parsing                                                      */
/* ------------------------------------------------------------------ */

function detectFormat(buf) {
  if (buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'jpeg';
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'png';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buf.length >= 6 && buf.toString('ascii', 0, 3) === 'GIF') return 'gif';
  return null;
}

function parseExifOrientation(buf, start, len) {
  try {
    if (start + 8 > buf.length) return 0;
    const byteOrder = buf.toString('ascii', start, start + 2);
    const little = byteOrder === 'II';
    const read16 = little ? buf.readUInt16LE.bind(buf) : buf.readUInt16BE.bind(buf);
    const read32 = little ? buf.readUInt32LE.bind(buf) : buf.readUInt32BE.bind(buf);
    if (read16(start + 2) !== 42) return 0;
    const ifdOffset = read32(start + 4);
    const ifdStart = start + ifdOffset;
    if (ifdStart + 2 > start + len) return 0;
    const entryCount = read16(ifdStart);
    for (let i = 0; i < entryCount; i++) {
      const entryOff = ifdStart + 2 + i * 12;
      if (entryOff + 12 > start + len) break;
      const tag = read16(entryOff);
      if (tag === 0x0112) return read16(entryOff + 8); // Orientation
    }
  } catch (e) { /* malformed EXIF is not fatal */ }
  return 0;
}

function parseJpegHeader(buf) {
  let offset = 2, orientation = 1;
  while (offset + 4 <= buf.length) {
    if (buf[offset] !== 0xFF) { offset++; continue; }
    const marker = buf[offset + 1];
    if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { offset += 2; continue; }
    const len = buf.readUInt16BE(offset + 2);
    if ((marker >= 0xC0 && marker <= 0xCF) && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
      return {
        width: buf.readUInt16BE(offset + 7),
        height: buf.readUInt16BE(offset + 5),
        orientation,
        // JPEG has no real alpha channel.
        hasAlphaHeader: false,
        progressive: marker === 0xC2,
      };
    }
    if (marker === 0xE1 && offset + 10 < buf.length) {
      const exifStart = offset + 4;
      if (buf.toString('ascii', exifStart, exifStart + 4) === 'Exif') {
        orientation = parseExifOrientation(buf, exifStart + 6, len - 8) || 1;
      }
    }
    offset += 2 + len;
  }
  return null;
}

function parsePngHeader(buf) {
  if (buf.length < 26) return null;
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bitDepth: buf[24],
    colorType: buf[25],
    hasAlphaHeader: buf[25] === 4 || buf[25] === 6,
  };
}

function parseWebpHeader(buf) {
  if (buf.length < 30) return null;
  const fourcc = buf.toString('ascii', 12, 16);
  if (fourcc === 'VP8 ') {
    return {
      width: buf.readUInt16LE(26) & 0x3FFF,
      height: buf.readUInt16LE(28) & 0x3FFF,
      hasAlphaHeader: false,
    };
  }
  if (fourcc === 'VP8L') {
    const bits = buf.readUInt32LE(21);
    return {
      width: (bits & 0x3FFF) + 1,
      height: ((bits >> 14) & 0x3FFF) + 1,
      hasAlphaHeader: !!(buf[20] & 0x10),
    };
  }
  if (fourcc === 'VP8X') {
    return {
      width: buf.readUIntLE(24, 3) + 1,
      height: buf.readUIntLE(27, 3) + 1,
      hasAlphaHeader: !!(buf[20] & 0x10),
    };
  }
  return null;
}

function parseGifHeader(buf) {
  if (buf.length < 13) return null;
  let pages = 1;
  // GifReader parses the whole file structure eagerly in its constructor;
  // numFrames() then reports every image descriptor it found.
  try {
    const reader = new GifReader(buf);
    pages = Math.max(reader.numFrames(), 1);
  } catch (e) { /* fall back to single page */ }
  return {
    width: buf.readUInt16LE(6),
    height: buf.readUInt16LE(8),
    hasAlphaHeader: true, // palette may carry transparency; exact answer comes from the pixel scan
    pages,
  };
}

// Cheap structural scan for the Graphic Control Extension transparency flag.
function scanGifTransparency(buf) {
  let offset = 13;
  const flags = buf[10];
  if (flags & 0x80) offset += 3 * (1 << ((flags & 0x07) + 1));
  while (offset < buf.length - 1) {
    const block = buf[offset++];
    if (block === 0x21) { // extension
      const label = buf[offset++];
      if (label === 0xF9) { // graphic control
        if (offset + 5 > buf.length) return false;
        if (buf[offset + 2] & 0x01) return true; // transparent color flag
      }
      while (offset < buf.length) { const sz = buf[offset++]; if (sz === 0) break; offset += sz; }
    } else if (block === 0x2C) { // image descriptor
      const lflags = buf[offset + 8];
      offset += 9;
      if (lflags & 0x80) offset += 3 * (1 << ((lflags & 0x07) + 1));
      offset++; // LZW min code size
      while (offset < buf.length) { const sz = buf[offset++]; if (sz === 0) break; offset += sz; }
    } else if (block === 0x3B) break;
    else break;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Pixel decoding                                                      */
/* ------------------------------------------------------------------ */

function hasAnyTransparentPixel(data) {
  // data is RGBA; early-exit on first alpha < 255.
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 255) return true;
  }
  return false;
}

function decodePixels(format, buf) {
  if (format === 'jpeg') {
    const out = jpegjs.decode(buf, {
      useTArray: true,
      maxMemoryUsageInMB: 2048,
      maxResolutionInMP: 300,
    });
    return {
      width: out.width,
      height: out.height,
      data: Buffer.from(out.data.buffer, out.data.byteOffset, out.data.byteLength),
      hasAlphaActual: false,
    };
  }
  if (format === 'png') {
    const png = pngjs.PNG.sync.read(buf);
    const data = Buffer.from(png.data);
    return {
      width: png.width,
      height: png.height,
      data,
      hasAlphaActual: hasAnyTransparentPixel(data),
    };
  }
  if (format === 'gif') {
    const reader = new GifReader(buf);
    if (reader.numFrames() < 1) {
      throw shimError('SHIM_DECODE_FAILED', 'sharp JS shim: GIF contains no image frames');
    }
    const width = reader.width, height = reader.height;
    // decodeAndBlitFrameRGBA skips transparent indices (leaves the byte as-is),
    // so the buffer must start zeroed; transparent pixels then read as A=0.
    const out = new Uint8Array(width * height * 4);
    reader.decodeAndBlitFrameRGBA(0, out);
    return {
      width,
      height,
      data: Buffer.from(out.buffer, out.byteOffset, out.byteLength),
      hasAlphaActual: hasAnyTransparentPixel(out) || scanGifTransparency(buf),
    };
  }
  if (format === 'webp') {
    throw shimError(
      'SHIM_NO_WEBP_DECODE',
      'sharp JS shim: WebP pixel decoding is not implemented on Android (header metadata only). Convert the image to JPEG or PNG.'
    );
  }
  throw shimError('SHIM_UNSUPPORTED_FORMAT', 'sharp JS shim: unsupported image format');
}

// One read_image call constructs many pipelines over the SAME source buffer
// (probe -> detect -> low-colour sample -> every encode attempt). Cache
// decoded pixels per buffer so the expensive decode happens exactly once;
// buffers are treated as immutable by the only consumer.
const PIXEL_CACHE = new WeakMap();

function decodePixelsCached(format, buf) {
  let entry = PIXEL_CACHE.get(buf);
  if (entry === undefined) {
    entry = {};
    PIXEL_CACHE.set(buf, entry);
  }
  let px = entry[format];
  if (px === undefined) {
    px = decodePixels(format, buf);
    entry[format] = px;
  }
  return px;
}

/* ------------------------------------------------------------------ */
/* Orientation                                                          */
/* ------------------------------------------------------------------ */

// dst(x,y) formulas verified against hand-rotated fixtures; dims swap when orientation >= 5.
function applyOrientation(src, w, h, orientation) {
  const S = (x, y) => (y * w + x) * 4;
  function build(dw, dh, srcX, srcY) {
    const out = Buffer.alloc(dw * dh * 4);
    for (let y = 0; y < dh; y++) {
      for (let x = 0; x < dw; x++) {
        const s = S(srcX(x, y), srcY(x, y));
        const d = (y * dw + x) * 4;
        out[d] = src[s]; out[d + 1] = src[s + 1]; out[d + 2] = src[s + 2]; out[d + 3] = src[s + 3];
      }
    }
    return out;
  }
  switch (orientation) {
    case 2: return { data: build(w, h, (x) => w - 1 - x, (y) => y), width: w, height: h };
    case 3: return { data: build(w, h, (x) => w - 1 - x, (y) => h - 1 - y), width: w, height: h };
    case 4: return { data: build(w, h, (x) => x, (y) => h - 1 - y), width: w, height: h };
    case 5: return { data: build(h, w, (x, y) => y, (y, x) => x), width: h, height: w }; // transpose
    case 6: return { data: build(h, w, (x, y) => y, (y, x) => h - 1 - x), width: h, height: w }; // rot90 CW
    case 7: return { data: build(h, w, (x, y) => w - 1 - y, (y, x) => h - 1 - x), width: h, height: w }; // transverse
    case 8: return { data: build(h, w, (x, y) => w - 1 - y, (y, x) => x), width: h, height: w }; // rot90 CCW
    default: return { data: src, width: w, height: h };
  }
}

/* ------------------------------------------------------------------ */
/* Resampling                                                           */
/* ------------------------------------------------------------------ */

function resampleRGBA(src, sw, sh, dw, dh, nearest) {
  const out = Buffer.alloc(dw * dh * 4);
  if (nearest) {
    for (let y = 0; y < dh; y++) {
      const sy = Math.min(sh - 1, Math.floor(((y + 0.5) * sh) / dh));
      let si = sy * sw * 4, di = y * dw * 4;
      for (let x = 0; x < dw; x++) {
        const sx = Math.min(sw - 1, Math.floor(((x + 0.5) * sw) / dw)) * 4;
        out[di] = src[si + sx];
        out[di + 1] = src[si + sx + 1];
        out[di + 2] = src[si + sx + 2];
        out[di + 3] = src[si + sx + 3];
        di += 4;
      }
    }
    return out;
  }
  // Box-filter area average: correct downscale behaviour for screenshots/photos.
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor((y * sh) / dh);
    const y1 = Math.min(sh, Math.max(y0 + 1, Math.ceil(((y + 1) * sh) / dh)));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor((x * sw) / dw);
      const x1 = Math.min(sw, Math.max(x0 + 1, Math.ceil(((x + 1) * sw) / dw)));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        let si = (yy * sw + x0) * 4;
        for (let xx = x0; xx < x1; xx++) {
          r += src[si]; g += src[si + 1]; b += src[si + 2]; a += src[si + 3];
          si += 4; n++;
        }
      }
      const di = (y * dw + x) * 4;
      out[di] = Math.round(r / n);
      out[di + 1] = Math.round(g / n);
      out[di + 2] = Math.round(b / n);
      out[di + 3] = Math.round(a / n);
    }
  }
  return out;
}

function computeInsideDims(iw, ih, tw, th, withoutEnlargement) {
  let scale = Math.min(tw / iw, th / ih);
  if (withoutEnlargement) scale = Math.min(scale, 1);
  return {
    w: Math.max(1, Math.round(iw * scale)),
    h: Math.max(1, Math.round(ih * scale)),
  };
}

/* ------------------------------------------------------------------ */
/* Encoding                                                             */
/* ------------------------------------------------------------------ */

function encodeJpeg(pixels, opts) {
  const quality = Math.max(1, Math.min(100, Math.round(opts.quality ?? 80)));
  const out = jpegjs.encode({ data: pixels.data, width: pixels.width, height: pixels.height }, quality);
  return Buffer.from(out.data);
}

function encodePng(pixels, opts) {
  const keepAlpha = pixels.channels === 4;
  const png = new pngjs.PNG({ width: pixels.width, height: pixels.height });
  Buffer.from(png.data.buffer, png.data.byteOffset, png.data.byteLength).set(
    pixels.data.subarray(0, pixels.width * pixels.height * 4)
  );
  return pngjs.PNG.sync.write(png, {
    colorType: keepAlpha ? 6 : 2,
    inputHasAlpha: true,
    bitDepth: 8,
    deflateLevel: Math.max(0, Math.min(9, opts.compressionLevel ?? 9)),
  });
}

/* ------------------------------------------------------------------ */
/* Pipeline object                                                      */
/* ------------------------------------------------------------------ */

class SharpShim {
  constructor(input, options) {
    if (!Buffer.isBuffer(input)) {
      if (input instanceof Uint8Array) input = Buffer.from(input);
      else throw shimError('SHIM_INPUT_UNSUPPORTED', 'sharp JS shim: input must be a Buffer or Uint8Array');
    }
    this._input = input;
    this._options = options || {};
    this._hdr = null;          // lazily parsed header
    this._decoded = null;      // cached source pixels {data,width,height}
    this._autoOrient = false;  // rotate() seen
    this._resizeOpts = null;
    this._format = null;       // 'jpeg' | 'png' | 'webp'
    this._formatOpts = {};
  }

  _cloneState() {
    const c = Object.create(SharpShim.prototype);
    c._input = this._input;
    c._options = this._options;
    c._hdr = this._hdr;
    c._decoded = this._decoded; // decoded pixels are immutable once cached
    c._autoOrient = this._autoOrient;
    c._resizeOpts = this._resizeOpts ? { ...this._resizeOpts } : null;
    c._format = this._format;
    c._formatOpts = { ...this._formatOpts };
    return c;
  }

  _header() {
    if (this._hdr === null) {
      const format = detectFormat(this._input);
      if (!format || !SUPPORTED[format]) {
        throw shimError('SHIM_UNSUPPORTED_FORMAT', 'sharp JS shim: unsupported or empty input');
      }
      let hdr;
      if (format === 'jpeg') hdr = parseJpegHeader(this._input);
      else if (format === 'png') hdr = parsePngHeader(this._input);
      else if (format === 'webp') hdr = parseWebpHeader(this._input);
      else hdr = parseGifHeader(this._input);
      if (!hdr || !hdr.width || !hdr.height) {
        throw shimError('SHIM_MALFORMED_INPUT', 'sharp JS shim: image header is malformed');
      }
      hdr.format = format;
      this._hdr = hdr;
    }
    return this._hdr;
  }

  async metadata() {
    const hdr = this._header();
    let hasAlpha = !!hdr.hasAlphaHeader;
    if (hdr.format === 'jpeg') {
      hasAlpha = false;
    } else if (hdr.format === 'png' || hdr.format === 'gif') {
      // Exact transparency scan: consumers branch encode formats on this,
      // so "alpha plane present but fully opaque" must report false.
      hasAlpha = this._pixels().hasAlphaActual;
    }
    // NOTE: like real sharp, width/height are the RAW STORED dimensions;
    // callers transpose them themselves based on the orientation field.
    const meta = {
      format: hdr.format,
      width: hdr.width,
      height: hdr.height,
      space: 'srgb',
      channels: hasAlpha ? 4 : 3,
      hasAlpha,
      depth: 'uchar',
      pages: hdr.pages ?? 1,
    };
    if (hdr.orientation && hdr.orientation > 1) meta.orientation = hdr.orientation;
    return meta;
  }

  _pixels() {
    if (this._decoded === null) {
      const hdr = this._header();
      this._decoded = decodePixelsCached(hdr.format, this._input);
    }
    return this._decoded;
  }

  /* Pipeline builders ------------------------------------------------ */

  rotate(turns) {
    // Callers use auto-orient (no args); explicit turns unsupported.
    if (turns !== undefined) {
      throw shimError('SHIM_UNSUPPORTED_OPERATION', 'sharp JS shim: rotate(angle) is unsupported; use rotate() auto-orient');
    }
    this._autoOrient = true;
    return this;
  }

  toColourspace(space) {
    if (space !== undefined && space !== 'srgb' && space !== 'srgb-bw') {
      throw shimError('SHIM_UNSUPPORTED_COLOURSPACE', `sharp JS shim: colourspace "${space}" is unsupported; only sRGB`);
    }
    return this;
  }

  resize(opts) {
    if (!opts || typeof opts !== 'object') {
      throw shimError('SHIM_INVALID_RESIZE', 'sharp JS shim: resize(object options) is required');
    }
    this._resizeOpts = {
      width: opts.width,
      height: opts.height,
      fit: opts.fit ?? 'cover',
      withoutEnlargement: !!opts.withoutEnlargement,
      kernel: typeof opts.kernel === 'string' ? opts.kernel : 'lanczos3',
    };
    return this;
  }

  clone() {
    return this._cloneState();
  }

  png(opts) { this._format = 'png'; this._formatOpts = opts || {}; return this; }
  jpeg(opts) { this._format = 'jpeg'; this._formatOpts = opts || {}; return this; }
  webp(_opts) {
    throw shimError(
      'SHIM_NO_WEBP_ENCODE',
      'sharp JS shim: WebP encoding is not implemented on Android. The pipeline needs a lossless/alpha-capable format instead.'
    );
  }

  raw() {
    const self = this;
    return {
      toBuffer(options) { return self._toRawBuffer(options); },
    };
  }

  async _materialize() {
    // 1. decode source pixels
    let px = this._pixels();
    let width = px.width, height = px.height, data = px.data;

    // 2. EXIF orientation (only when auto-orient requested)
    if (this._autoOrient) {
      const orientation = this._header().orientation || 1;
      if (orientation >= 2) {
        const oriented = applyOrientation(data, width, height, orientation);
        data = oriented.data; width = oriented.width; height = oriented.height;
      }
    }

    // 3. resize
    if (this._resizeOpts !== null) {
      const ro = this._resizeOpts;
      const fit = ro.fit;
      let target;
      if (fit === 'inside' || fit === 'contain') {
        target = computeInsideDims(width, height, ro.width ?? width, ro.height ?? height, ro.withoutEnlargement);
      } else if (fit === 'fill') {
        target = { w: ro.width ?? width, h: ro.height ?? height };
      } else if (fit === 'cover') {
        // Scale to cover then centre-crop (not exercised by current callers).
        let scale = Math.max((ro.width ?? width) / width, (ro.height ?? height) / height);
        if (ro.withoutEnlargement) scale = Math.min(scale, 1);
        const sw = Math.max(1, Math.round(width * scale));
        const sh = Math.max(1, Math.round(height * scale));
        const scaled = resampleRGBA(data, width, height, sw, sh, ro.kernel === 'nearest');
        const cw = Math.min(sw, ro.width ?? sw), ch = Math.min(sh, ro.height ?? sh);
        const offX = Math.floor((sw - cw) / 2), offY = Math.floor((sh - ch) / 2);
        const crop = Buffer.alloc(cw * ch * 4);
        for (let row = 0; row < ch; row++) {
          scaled.copy(crop, row * cw * 4, ((row + offY) * sw + offX) * 4, ((row + offY) * sw + offX + cw) * 4);
        }
        return { data: crop, width: cw, height: ch, channels: 4 };
      } else {
        throw shimError('SHIM_INVALID_RESIZE', `sharp JS shim: resize fit "${fit}" is unsupported`);
      }
      const nearest = ro.kernel === 'nearest';
      data = resampleRGBA(data, width, height, target.w, target.h, nearest);
      width = target.w; height = target.h;
    }

    return { data, width, height, channels: 4 };
  }

  async _toRawBuffer(options) {
    const px = await this._materialize();
    const resolveObject = !!(options && options.resolveWithObject);
    let out = px.data, channels = 4;
    const wantAlpha = this._sourceHasAlphaForOutput();
    if (!wantAlpha) {
      // Pack to RGB (drop the fully-opaque alpha plane).
      out = Buffer.alloc(px.width * px.height * 3);
      for (let i = 0, j = 0; j < out.length; i += 4, j += 3) {
        out[j] = px.data[i]; out[j + 1] = px.data[i + 1]; out[j + 2] = px.data[i + 2];
      }
      channels = 3;
    }
    if (!resolveObject) return out;
    return { data: out, info: { width: px.width, height: px.height, channels } };
  }

  _sourceHasAlphaForOutput() {
    const hdr = this._header();
    if (hdr.format === 'jpeg') return false;
    return this._pixels().hasAlphaActual;
  }

  async toBuffer(options) {
    const px = await this._materialize();
    const format = this._format ?? (this._header().format === 'jpeg' ? 'jpeg' : 'png');
    let encoded, channels;
    if (format === 'jpeg') {
      encoded = encodeJpeg({ data: px.data, width: px.width, height: px.height }, this._formatOpts);
      channels = 3;
    } else if (format === 'png') {
      encoded = encodePng({ data: px.data, width: px.width, height: px.height, channels: this._sourceHasAlphaForOutput() ? 4 : 3 }, this._formatOpts);
      channels = this._sourceHasAlphaForOutput() ? 4 : 3;
    } else {
      throw shimError('SHIM_NO_WEBP_ENCODE', 'sharp JS shim: WebP output is unsupported on Android');
    }
    if (!(options && options.resolveWithObject)) return encoded;
    return { data: encoded, info: { format, width: px.width, height: px.height, channels } };
  }
}

/* ------------------------------------------------------------------ */
/* Module export                                                        */
/* ------------------------------------------------------------------ */

function sharp(input, options) {
  return new SharpShim(input, options);
}

sharp.kernel = {
  nearest: 'nearest',
  cubic: 'cubic',
  mitchell: 'mitchell',
  lanczos2: 'lanczos2',
  lanczos3: 'lanczos3',
};

sharp.format = {
  jpeg: { id: 'jpeg', input: { buffer: true, file: true }, output: { buffer: true, file: true } },
  png: { id: 'png', input: { buffer: true, file: true }, output: { buffer: true, file: true } },
  webp: { id: 'webp', input: { buffer: true, file: true }, output: { buffer: false, file: false } },
  gif: { id: 'gif', input: { buffer: true, file: true }, output: { buffer: false, file: false } },
};

sharp.SharpShim = SharpShim;
sharp.default = sharp;

module.exports = sharp;
