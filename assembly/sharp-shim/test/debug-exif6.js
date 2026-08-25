'use strict';
/* Step-by-step trace of the exif6.jpg normalization path. */
const { createRequire } = require('module');
const { join, dirname } = require('path');
const { readFileSync } = require('fs');
const require_ = createRequire(__filename);
const sharp = require_(join(__dirname, '..', 'index.js'));

(async () => {
	const buf = readFileSync(join(__dirname, 'fixtures', 'exif6.jpg'));
	const meta = await sharp(buf).metadata();
	console.log('metadata:', JSON.stringify(meta));

	// preparedPipeline(data, width, height) with detected dims:
	const W = meta.width, H = meta.height;
	const p = sharp(buf).rotate().toColourspace('srgb').resize({ width: W, height: H, fit: 'inside', withoutEnlargement: true });
	const raw = await p.raw().toBuffer({ resolveWithObject: true });
	console.log('oriented+resized raw:', JSON.stringify(raw.info));

	const pngOut = await sharp(buf).rotate().resize({ width: W, height: H, fit: 'inside', withoutEnlargement: true }).png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true });
	console.log('png out info:', JSON.stringify(pngOut.info), `${pngOut.data.length}B`);
	const pngMeta = await sharp(pngOut.data).metadata();
	console.log('png re-probe:', JSON.stringify(pngMeta));

	const jpgOut = await sharp(buf).rotate().resize({ width: W, height: H, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer({ resolveWithObject: true });
	console.log('jpeg out info:', JSON.stringify(jpgOut.info), `${jpgOut.data.length}B`);
	const jpgMeta = await sharp(jpgOut.data).metadata();
	console.log('jpeg re-probe:', JSON.stringify(jpgMeta));
})();
