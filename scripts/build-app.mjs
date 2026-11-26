// Bundles one Forge app into apps/<app>/dist/index.js (CommonJS, single file) for manual
// packaging. @ripple/contracts is resolved from source and inlined, so the deployed bundle
// has no workspace symlink and no node_modules to resolve at runtime.
import { build } from 'esbuild';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const app = process.argv[2];
if (app !== 'gate' && app !== 'brain') {
  console.error('usage: node scripts/build-app.mjs <gate|brain>');
  process.exit(1);
}
const root = fileURLToPath(new URL('..', import.meta.url));
const outdir = `${root}apps/${app}/dist`;
rmSync(outdir, { recursive: true, force: true });

const result = await build({
  entryPoints: [`${root}apps/${app}/src/index.ts`],
  outfile: `${outdir}/index.js`,
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  alias: { '@ripple/contracts': `${root}packages/contracts/src/index.ts` },
  legalComments: 'none',
  metafile: true,
  logLevel: 'warning',
});

// The app's own package.json says "type": "module"; the uploaded bundle is CommonJS.
writeFileSync(`${outdir}/package.json`, '{ "type": "commonjs" }\n');

const bundle = readFileSync(`${outdir}/index.js`, 'utf8');
const inputs = Object.keys(result.metafile.inputs);
const problems = [];
if (/require\(["']@ripple\//.test(bundle)) problems.push('@ripple/contracts was left as an external require');
if (!inputs.some((file) => file.includes('packages/contracts/src/signing.ts'))) problems.push('contracts signing module is not in the bundle');
if (inputs.some((file) => /\.test\.ts$|\/testing\/|fixtures\.ts$/.test(file))) problems.push('test code leaked into the bundle');
if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`${app}: dist/index.js ${(bundle.length / 1024).toFixed(0)} kB, ${inputs.length} modules, contracts inlined`);
