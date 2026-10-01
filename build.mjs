import * as esbuild from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

const watch = process.argv.includes('--watch');
const dev = watch || process.argv.includes('--dev');
const outdir = 'dist';

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

/** Each entry becomes dist/<key>.js as a self-contained IIFE. */
const entryPoints = {
  inject: 'src/inject/main.ts',
  content: 'src/content/relay.ts',
  sw: 'src/background/service-worker.ts',
  studio: 'src/studio/studio.ts',
  'encoder.worker': 'src/studio/encoder.worker.ts',
  popup: 'src/popup/popup.ts',
  options: 'src/options/options.ts',
};

const staticFiles = [
  ['src/manifest.json', `${outdir}/manifest.json`],
  ['src/studio/studio.html', `${outdir}/studio.html`],
  ['src/popup/popup.html', `${outdir}/popup.html`],
  ['src/options/options.html', `${outdir}/options.html`],
  ['src/assets', `${outdir}/assets`],
];

async function copyStatic() {
  for (const [from, to] of staticFiles) {
    await cp(from, to, { recursive: true });
  }
}

const copyPlugin = {
  name: 'copy-static',
  setup(build) {
    build.onEnd(async (result) => {
      await copyStatic();
      const when = new Date().toLocaleTimeString();
      if (result.errors.length) console.error(`[camboi] ${when} build failed`);
      else console.log(`[camboi] ${when} built -> ${outdir}/`);
    });
  },
};

const options = {
  entryPoints,
  outdir,
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  platform: 'browser',
  sourcemap: dev ? 'inline' : false,
  minify: !dev,
  legalComments: 'none',
  logLevel: 'warning',
  plugins: [copyPlugin],
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('[camboi] watching...');
} else {
  await esbuild.build(options);
}
