'use strict';
/*
 * End-to-end test for the Android sharp shim.
 *
 * Phase A drives the REAL dsh-attachment-local production bundle (the exact
 * file deployed on device, including the SHIM_NO_WEBP fallback patch) through
 * prepareImageFile() and readRequestImageFile(). Phase B unit-tests the shim
 * surface directly (orientation pixels, metadata facts, decode caching,
 * webp error codes).
 *
 * Run: node test/run-test.mjs
 */
import { createRequire } from 'module';
import { mkdtempSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const sharp = require_(join(here, '..', 'index.js'));
const FIXTURES = join(here, 'fixtures');
const readFixture = (name) => readFileSync(join(FIXTURES, name));

const ATTACHMENT_LOCAL = 'E:/code/dsh-android/assembly/payload/dsh/node_modules/@deepseek-ai/dsh-attachment-local/lib/index.js';
const att = await import('file:///' + ATTACHMENT_LOCAL.replace(/\\/g, '/'));

const results = [];
let seq = 0;
async function test(name, fn) {
	seq++;
	const id = `T${String(seq).padStart(2, '0')}`;
	const t0 = Date.now();
	try {
		await fn();
		results.push({ pass: true });
		console.log(`${id} PASS  ${name} (${Date.now() - t0} ms)`);
	} catch (e) {
		results.push({ pass: false });
		console.log(`${id} FAIL  ${name} (${Date.now() - t0} ms)\n      ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n      ') : e}`);
	}
}
function assert(cond, msg) { if (!cond) throw new Error('assert: ' + msg); }
function approx(actual, expected, tol, label) {
	assert(Math.abs(actual - expected) <= tol, `${label}: got ${actual}, want ~${expected} (+-${tol})`);
}

/* Shared policies mirroring device defaults, tightened where noted. */
const LIMITS = {
	maxImageBytes: att.DEFAULT_MAX_IMAGE_BYTES,
	maxImagePixels: att.DEFAULT_MAX_IMAGE_PIXELS,
	maxImageDimension: att.DEFAULT_MAX_IMAGE_DIMENSION,
};

(async () => {
	const scratch = mkdtempSync(join(tmpdir(), 'sharp-shim-test-'));

	/* ---------------- Phase B first: direct shim surface ------------- */

	await test('shim: module surface', () => {
		assert(typeof sharp === 'function', 'callable');
		assert(sharp.kernel.nearest === 'nearest', 'kernel constants');
	});

	const photo = readFixture('photo.jpg');
	await test('shim: metadata facts photo.jpg', async () => {
		const meta = await sharp(photo).metadata();
		assert(meta.format === 'jpeg' && meta.width === 900 && meta.height === 600, JSON.stringify(meta));
		assert(meta.hasAlpha === false && meta.depth === 'uchar' && meta.space === 'srgb', 'basic fields');
		assert(!('orientation' in meta), 'no orientation key when 1');
	});

	await test('shim: rgba-opaque reports hasAlpha=false', async () => {
		const meta = await sharp(readFixture('rgba-opaque.png')).metadata();
		assert(meta.hasAlpha === false, `got ${meta.hasAlpha}`);
	});
	await test('shim: real transparency reported true', async () => {
		const meta = await sharp(readFixture('rgba-transparent-ui.png')).metadata();
		assert(meta.hasAlpha === true, `got ${meta.hasAlpha}`);
	});
	await test('shim: gif pages count', async () => {
		const staticMeta = await sharp(readFixture('static.gif')).metadata();
		const animMeta = await sharp(readFixture('animated.gif')).metadata();
		assert(staticMeta.pages === 1, `static pages ${staticMeta.pages}`);
		assert(animMeta.pages >= 2, `animated pages ${animMeta.pages}`);
	});
	await test('shim: webp header metadata ok, pixels fail loud', async () => {
		// Minimal valid VP8X header (from spec): RIFF/WEBP + VP8X chunk.
		const buf = Buffer.alloc(30);
		buf.write('RIFF', 0, 'latin1'); buf.write('WEBP', 8, 'latin1'); buf.write('VP8X', 12, 'latin1');
		buf.writeUInt32LE(10, 16);
		buf[20] = 0x10; // alpha flag
		buf.writeUIntLE(199, 24, 3); // width-1
		buf.writeUIntLE(149, 27, 3); // height-1
		const meta = await sharp(buf).metadata();
		assert(meta.format === 'webp' && meta.width === 200 && meta.height === 150 && meta.hasAlpha === true, JSON.stringify(meta));
		let err = null;
		try { await sharp(buf).raw().toBuffer(); } catch (e) { err = e; }
		assert(err && err.code === 'SHIM_NO_WEBP_DECODE', `code ${err && err.code}`);
	});
	await test('shim: exif6 raw dims kept + orientation field', async () => {
		const buf = readFixture('exif6.jpg');
		const meta = await sharp(buf).metadata();
		// Real sharp reports RAW STORED dims; callers transpose via orientation.
		assert(meta.width === 8 && meta.height === 6 && meta.orientation === 6, JSON.stringify(meta));
		const rot = await sharp(buf).rotate().raw().toBuffer({ resolveWithObject: true });
		assert(rot.info.width === 6 && rot.info.height === 8, `rotated ${rot.info.width}x${rot.info.height}`);
		approx(rot.data[0], 20, 70, 'TL red');
		approx(rot.data[2], 220, 70, 'TL blue');
		const plain = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
		assert(plain.info.width === 8 && plain.info.height === 6, 'without rotate(): stored dims');
	});
	await test('shim: nearest kernel resize honoured', async () => {
		const out = await sharp(photo).resize({ width: 128, height: 128, fit: 'inside', withoutEnlargement: true, kernel: sharp.kernel.nearest })
			.raw().toBuffer({ resolveWithObject: true });
		assert(out.info.width === 128 && out.info.height === 85, `${out.info.width}x${out.info.height}`);
		assert(out.info.channels === 3, `channels ${out.info.channels}`);
	});
	await test('shim: decode cache shared per buffer+format', () => {
		const a = sharp(photo)._pixels();
		const b = sharp(photo)._pixels();
		assert(a === b, 'same instance');
	});

	/* ---------------- Phase A: production bundle flows --------------- */

	async function normalize(name, policyOverrides) {
		const data = readFixture(name);
		const ext = name.split('.').pop();
		const mediaType = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif' }[ext];
		const policy = { maxBytes: att.DEFAULT_NORMALIZED_IMAGE_MAX_BYTES, maxDimension: att.DEFAULT_NORMALIZED_IMAGE_MAX_DIMENSION, ...policyOverrides };
		return att.prepareImageFile({ data, mediaType }, LIMITS, policy);
	}
	function mediaOf(name) {
		const ext = name.split('.').pop();
		return { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif' }[ext];
	}

	await test('flow: photo.jpg normalize -> jpeg within cap', async () => {
		const t0 = Date.now();
		const out = await normalize('photo.jpg', { maxBytes: 64 * 1024 });
		console.log(`      -> ${out.ref.mediaType} ${out.ref.width}x${out.ref.height} ${(out.data.byteLength / 1024).toFixed(1)}KB in ${Date.now() - t0}ms`);
		assert(out.ref.mediaType === 'image/jpeg', out.ref.mediaType);
		assert(out.data.byteLength <= 64 * 1024, 'cap');
		assert(out.ref.width === 900 && out.ref.height === 600, 'dims kept');
	});

	await test('flow: screenshot-rgb.png pass-through byte-identical', async () => {
		const data = readFixture('screenshot-rgb.png');
		const out = await att.prepareImageFile({ data, mediaType: 'image/png' }, LIMITS, { maxBytes: att.DEFAULT_NORMALIZED_IMAGE_MAX_BYTES, maxDimension: att.DEFAULT_NORMALIZED_IMAGE_MAX_DIMENSION });
		assert(out.data === data, 'pass-through returns same buffer');
		assert(out.ref.width === 720 && out.ref.height === 1280, 'dims');
	});

	await test('flow: rgba-opaque.png survives (was webp dead end pre-fix)', async () => {
		const out = await normalize('rgba-opaque.png', { maxBytes: 16 * 1024 });
		assert(['image/png', 'image/jpeg'].includes(out.ref.mediaType), out.ref.mediaType);
		assert(out.data.byteLength <= 16 * 1024, `cap ${(out.data.byteLength / 1024).toFixed(1)}KB`);
	});

	await test('flow: transparent flat PNG keeps alpha via png/webp-free path', async () => {
		const out = await normalize('rgba-transparent-ui.png', {});
		assert(out.ref.mediaType !== undefined, 'produced');
		if (out.ref.mediaType === 'image/png') {
			// re-probe alpha preserved
			const meta = await sharp(Buffer.from(out.data)).metadata();
			assert(meta.hasAlpha === true, 'alpha kept');
		}
		// webp output would mean real sharp; shim cannot produce it.
		assert(out.ref.mediaType !== 'image/webp', 'no webp from shim');
	});

	await test('flow: transparent NOISE -> clean IMAGE_TOO_LARGE (poisoned candidates)', async () => {
		// Tight byte cap forces the encode path (default 4MB cap would let the
		// 1.3MB source pass through untouched).
		let err = null;
		try { await normalize('rgba-transparent-noise.png', { maxBytes: 128 * 1024 }); } catch (e) { err = e; }
		assert(err !== null, 'must fail');
		console.log(`      -> ${err.constructor.name}: ${err.code || '(no code)'}`);
		assert(err.code === 'IMAGE_TOO_LARGE' || err.message.includes('byte cap'), err.message);
	});

	await test('flow: noise.png heavy shrink loop within 48KB', async () => {
		const t0 = Date.now();
		const out = await normalize('noise.png', { maxBytes: 48 * 1024 });
		console.log(`      -> ${out.ref.mediaType} ${out.ref.width}x${out.ref.height} ${(out.data.byteLength / 1024).toFixed(1)}KB in ${Date.now() - t0}ms`);
		assert(out.data.byteLength <= 48 * 1024, 'cap');
		assert(out.ref.width < 1400, 'shrunk');
	});

	await test('flow: animated.gif -> single-frame normalized', async () => {
		const out = await normalize('animated.gif', {});
		const meta = await sharp(Buffer.from(out.data)).metadata();
		assert((meta.pages ?? 1) === 1, `pages ${meta.pages}`);
		assert(!('animated' in out.ref) || !out.ref.animated, 'ref not animated');
	});

	await test('flow: exif6.jpg normalized upright 6x8', async () => {
		const out = await normalize('exif6.jpg', {});
		assert(out.ref.width === 6 && out.ref.height === 8, `${out.ref.width}x${out.ref.height}`);
		assert(!out.ref.originalDimensions, 'no downscale recorded');
	});

	await test('flow: request image + cache roundtrip', async () => {
		const norm = await normalize('photo.jpg', { maxBytes: 256 * 1024 });
		const root = join(scratch, 'attachments-root');
		const policy = { maxPixels: 300000, maxBytes: 96 * 1024 };
		const want = att.requestImageDimensions(norm.ref.width, norm.ref.height, policy.maxPixels);
		const t0 = Date.now();
		const first = await att.readRequestImageFile(root, norm, policy);
		const createMs = Date.now() - t0;
		const t1 = Date.now();
		const second = await att.readRequestImageFile(root, norm, policy);
		const cacheMs = Date.now() - t1;
		console.log(`      -> ${first.width}x${first.height} ${first.mediaType} create=${createMs}ms cached=${cacheMs}ms`);
		assert(first.width === want.width && first.height === want.height, `want ${want.width}x${want.height}`);
		assert(first.data.byteLength <= policy.maxBytes, 'request byte budget');
		assert(second.data.byteLength === first.data.byteLength, 'cache identical size');
		assert(cacheMs < createMs, 'cached faster than create');
		// Cache file physically exists below root.
		assert(existsSync(join(root, 'request-images')), 'cache dir written');
	});

	if (existsSync(join(FIXTURES, 'real-photo.jpg'))) {
		await test('flow: real Windows wallpaper full pipeline', async () => {
			const t0 = Date.now();
			const out = await normalize('real-photo.jpg', {});
			console.log(`      -> ${out.ref.mediaType} ${out.ref.width}x${out.ref.height} ${(out.data.byteLength / 1024).toFixed(1)}KB in ${Date.now() - t0}ms`);
			assert(out.data.byteLength > 1000, 'substantial output');
		});
	}

	/* Summary */
	const failed = results.filter((r) => !r.pass);
	console.log(`\n========================================\n${results.length - failed.length}/${results.length} passed`);
	if (failed.length > 0) process.exitCode = 1;
})().catch((e) => {
	console.error('harness crashed:', e);
	process.exitCode = 1;
});
