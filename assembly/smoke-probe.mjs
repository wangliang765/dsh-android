'use strict';
/* Boot probe: replicate bin.js's web boot and print the full failure cause chain. */
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dshRoot = 'E:/code/dsh-android/assembly/payload/dsh/node_modules/@deepseek-ai/dsh';
const appBoot = await import(pathToFileURL('E:/code/dsh-android/assembly/payload/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js').href);

// Mirror profile-boot's wiring: boot(binName, absoluteConfigPath, patches, prepare, bareModuleBaseUrl)
const home = process.env.DSH_HOME;
const configPath = join(home, 'profiles', 'web', 'cordis.yml');
const patchPath = join(home, 'profiles', 'web', 'cordis.patch.yml');

console.log('[probe] booting with configPath =', configPath);
try {
  const ctx = await appBoot.boot('probe', configPath, [patchPath], undefined, pathToFileURL(dirname(fileURLToPath(import.meta.url))) .href + '/');
  console.log('[probe] BOOT OK; entries:');
  for (const entry of ctx.loader.entries()) {
    const state = entry.fiber === void 0 ? 'no-fiber' : ['pending','loading','active','failed','disposed','unloading'][entry.fiber.state];
    if (/vision|toggle/.test(entry.options.name ?? '') || entry.disabled) {
      console.log(`  ${entry.id} name=${entry.options.name} state=${state} disabled=${!!entry.disabled}`);
    }
  }
  process.exit(0);
} catch (error) {
  let e = error;
  let depth = 0;
  while (e && depth < 6) {
    console.log(`[cause ${depth}] ${e.message}`);
    if (e.cause === e || e.cause === undefined) break;
    e = e.cause;
    depth++;
  }
  process.exit(1);
}
