'use strict';
/* Probe v2: call the REAL runProfile; on failure walk error.cause chain. */
const chunk = await import('file:///E:/code/dsh-android/assembly/payload/dsh/node_modules/@deepseek-ai/dsh/lib/profile-boot-BnJoK_kl.js');
const { loadLayeredEnv } = await import('file:///E:/code/dsh-android/assembly/payload/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js');

function printCause(error) {
  let e = error, depth = 0;
  while (e && depth < 8) {
    console.log(`[cause ${depth}] ${e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e)}`);
    if (!e.cause || e.cause === e) break;
    e = e.cause;
    depth++;
  }
}

process.on('unhandledRejection', (err) => {
  console.log('[unhandledRejection]');
  printCause(err);
});
process.on('uncaughtException', (err) => {
  console.log('[uncaughtException]');
  printCause(err);
  process.exit(1);
});

try {
  await chunk.runProfile({
    environment: loadLayeredEnv('dsh'),
    profile: 'web',
    patchFiles: [process.env.SMOKE_EXTRA ?? ''].filter((p) => p.length > 0),
    args: ['--host', '127.0.0.1', '--port', '31560', '--no-open'],
  });
  console.log('[probe] runProfile resolved (server exited)');
} catch (error) {
  console.log('[probe] runProfile REJECTED');
  printCause(error);
  process.exit(1);
}
