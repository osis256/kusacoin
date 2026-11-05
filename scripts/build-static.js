'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const output = path.join(root, 'out');
const configuredApiUrl = (process.env.API_BASE_URL || '').trim();
let apiBaseUrl = '';

if (configuredApiUrl) {
  const parsed = new URL(configuredApiUrl);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
    || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('API_BASE_URLにはAPIサーバーのURL（オリジン）を指定してください。');
  }
  apiBaseUrl = parsed.origin;
}

fs.mkdirSync(output, { recursive: true });
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const scriptTag = '  <script src="client.js" defer></script>';
if (!html.includes(scriptTag)) throw new Error('index.htmlにclient.jsのscriptタグが見つかりません。');

fs.writeFileSync(
  path.join(output, 'index.html'),
  html.replace(scriptTag, `  <script>window.KUSACOIN_API_BASE_URL = ${JSON.stringify(apiBaseUrl)};</script>\n${scriptTag}`),
);
fs.copyFileSync(path.join(root, 'client.js'), path.join(output, 'client.js'));

console.log(`Static site generated at ${path.relative(root, output)}${apiBaseUrl ? ` (API: ${apiBaseUrl})` : ''}`);
