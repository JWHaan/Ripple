// Fails if either manifest crosses the workspace/site scope boundary.
import { readFileSync } from 'node:fs';

function scopes(path) {
  const lines = readFileSync(path, 'utf8').split('\n');
  const start = lines.findIndex((line) => /^  scopes:\s*$/.test(line));
  if (start === -1) throw new Error(`${path}: no permissions.scopes block`);
  const found = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    // list form `- scope` or map form `scope: {}` / `scope:`
    const match = /^    (?:- ['"]?([a-z0-9:._-]+)['"]?|([a-z0-9._-]+(?::[a-z0-9._-]+)+):(?: \{\})?)\s*$/.exec(line);
    if (!match && /^      \S/.test(line)) continue;
    if (!match) break;
    found.push(match[1] ?? match[2]);
  }
  return found;
}

const isBitbucket = (scope) => scope.endsWith(':bitbucket');
const gate = scopes('apps/gate/manifest.yml');
const brain = scopes('apps/brain/manifest.yml');

const violations = [
  ...gate.filter((s) => !isBitbucket(s) && s !== 'storage:app').map((s) => `gate has non-workspace scope: ${s}`),
  ...brain.filter(isBitbucket).map((s) => `brain has workspace scope: ${s}`),
];
if (gate.length === 0 || brain.length === 0) violations.push('a manifest declares no scopes');

console.log(`gate:  ${gate.join(', ')}`);
console.log(`brain: ${brain.join(', ')}`);
if (violations.length > 0) {
  console.error(violations.join('\n'));
  process.exit(1);
}
console.log('scope boundary OK');
