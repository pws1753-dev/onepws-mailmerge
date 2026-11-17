import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, extname } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.name, 'OnePWS Mail Merge');
assert.deepEqual(manifest.permissions, ['identity', 'storage']);
assert.deepEqual(manifest.oauth2.scopes.sort(), ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/spreadsheets.readonly'].sort());
assert.deepEqual(manifest.host_permissions.sort(), ['https://gmail.googleapis.com/*', 'https://www.googleapis.com/*', 'https://sheets.googleapis.com/*', 'https://mailmerge.onepws.com/*'].sort());
assert.ok(manifest.content_security_policy.extension_pages.includes("font-src 'self'"));
assert.ok(manifest.content_security_policy.extension_pages.includes('connect-src https://gmail.googleapis.com https://www.googleapis.com https://sheets.googleapis.com https://mailmerge.onepws.com;'));
for (const weight of ['Regular', 'Medium', 'SemiBold', 'Bold']) {
  const font = readFileSync(join(root, `assets/fonts/BeVietnamPro-${weight}.ttf`));
  assert.equal(font.readUInt32BE(0), 0x00010000, 'Bundled font must be a TrueType file.');
}
assert.ok(manifest.key, 'A stable extension key is required. Run node scripts/configure.mjs.');
assert.ok(!manifest.update_url, 'Personal build must not update from a third-party store item.');
const paths = [manifest.background.service_worker, ...Object.values(manifest.icons),
  ...Object.values(manifest.action.default_icon), ...manifest.content_scripts.flatMap(script => [...script.js, ...script.css]),
  ...manifest.web_accessible_resources.flatMap(resource => resource.resources)];
for (const path of paths) assert.ok(existsSync(join(root, path)), `Missing manifest resource: ${path}`);
const html = readFileSync(join(root, 'app.html'), 'utf8');
for (const [, path] of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
  if (!/^https?:/.test(path)) assert.ok(existsSync(join(root, path)), `Missing page resource: ${path}`);
}
const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
assert.equal(new Set(ids).size, ids.length, 'DOM IDs must be unique.');
const app = readFileSync(join(root, 'app.js'), 'utf8');
for (const [, id] of app.matchAll(/\$\('([^']+)'\)/g)) assert.ok(ids.includes(id), `Missing app element: ${id}`);
assert.ok(!/\.innerHTML\s*=|insertAdjacentHTML|\beval\s*\(|new Function\s*\(/.test(app), 'App must render imported text using safe DOM APIs.');
for (const file of ['app.css', 'onepws-gmail.css']) assert.ok(!/@import|url\(['"]?https?:/i.test(readFileSync(join(root, file), 'utf8')), 'Fonts and visual assets must be local.');
function files(path) { return readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? (entry.name === 'node_modules' ? [] : files(join(path, entry.name))) : [join(path, entry.name)]); }
for (const file of files(root)) {
  if (['.js', '.mjs'].includes(extname(file))) execFileSync(process.execPath, ['--check', file]);
  if (['.js', '.mjs', '.json', '.html', '.css'].includes(extname(file)) && !file.endsWith('check.mjs')) {
    assert.ok(!/gma[s]{2}|wordzen|apigma3|gmapi1/i.test(readFileSync(file, 'utf8')), `Old branding or service dependency: ${file}`);
  }
}
console.log('OnePWS manifest, assets, local page references, JavaScript syntax, and service/branding checks passed.');
console.log(manifest.oauth2.client_id.startsWith('YOUR_') ? 'Gmail connection still needs your Google OAuth client ID.' : 'OAuth client ID configured.');
