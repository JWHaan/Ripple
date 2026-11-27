// Bundles one Forge app into apps/<app>/dist/index.js (CommonJS, single file) for manual
// packaging. @ripple/contracts is resolved from source and inlined, so the deployed bundle
// has no workspace symlink and no node_modules to resolve at runtime.
import { build } from 'esbuild';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
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
// A bundle that throws while loading breaks every module of the app at once (hook, merge
// check, web trigger), so load it and check each manifest handler is exported.
const handlers = [...readFileSync(`${root}apps/${app}/manifest.yml`, 'utf8').matchAll(/handler:\s*index\.(\w+)/g)].map((m) => m[1]);
// Some @forge packages look up the Forge runtime while loading; an empty stand-in is enough
// to load the module here. Nothing is invoked.
globalThis.__forge_runtime__ ??= {};
try {
  const loaded = createRequire(import.meta.url)(`${outdir}/index.js`);
  for (const name of handlers) if (typeof loaded[name] !== 'function') problems.push(`manifest handler index.${name} is not an exported function`);
} catch (cause) {
  problems.push(`bundle throws on load: ${cause instanceof Error ? cause.message : String(cause)}`);
}
if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`${app}: dist/index.js ${(bundle.length / 1024).toFixed(0)} kB, ${inputs.length} modules, contracts inlined`);

// Gate also serves the PR overview panel (Custom UI) from dist/panel.
if (app === 'gate') {
  const { build: viteBuild } = await import('vite');
  await viteBuild({ configFile: `${root}apps/gate/vite.config.ts` });
  const panelDir = `${outdir}/panel`;
  const assets = existsSync(`${panelDir}/assets`) ? readdirSync(`${panelDir}/assets`) : [];
  const scripts = assets.filter((file) => file.endsWith('.js')).map((file) => readFileSync(`${panelDir}/assets/${file}`, 'utf8'));
  const panelProblems = [];
  if (!existsSync(`${panelDir}/index.html`)) panelProblems.push('panel index.html was not built');
  if (scripts.length === 0) panelProblems.push('panel has no script bundle');
  if (scripts.some((code) => /node:crypto|createHmac/.test(code))) panelProblems.push('server-only contracts code leaked into the panel bundle');
  if (/src="\//.test(readFileSync(`${panelDir}/index.html`, 'utf8'))) panelProblems.push('panel references an absolute asset path');
  if (panelProblems.length > 0) {
    console.error(panelProblems.join('\n'));
    process.exit(1);
  }
  const kb = scripts.reduce((total, code) => total + code.length, 0) / 1024;
  console.log(`gate: dist/panel ${kb.toFixed(0)} kB of script, ${assets.length} assets`);
}
