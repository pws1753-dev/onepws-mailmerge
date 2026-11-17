import { readFileSync, writeFileSync } from 'node:fs';
import { createHash, generateKeyPairSync } from 'node:crypto';

const path = new URL('../manifest.json', import.meta.url);
const manifest = JSON.parse(readFileSync(path, 'utf8'));
const clientId = process.argv[2];
if (clientId && !/^\d+-[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(clientId)) {
  console.error('Expected a Google OAuth client ID, for example 123456-abc.apps.googleusercontent.com. Do not enter a client secret.');
  process.exit(1);
}
if (!manifest.key) {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  manifest.key = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
}
if (clientId) manifest.oauth2.client_id = clientId;
writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
const extensionId = [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32)]
  .map(char => String.fromCharCode(97 + parseInt(char, 16))).join('');
console.log(`OnePWS extension ID: ${extensionId}`);
console.log(clientId ? 'OAuth client saved. Reload the extension in chrome://extensions and reopen OnePWS.' : 'Use this ID when creating your Chrome Extension OAuth client. Then run this script with your client ID.');
