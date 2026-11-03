'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const standalone = path.join(root, '.next', 'standalone');
const publicDirectory = path.join(standalone, 'public');
const staticSource = path.join(root, '.next', 'static');
const staticDestination = path.join(standalone, '.next', 'static');

fs.mkdirSync(publicDirectory, { recursive: true });
fs.copyFileSync(path.join(root, 'index.html'), path.join(publicDirectory, 'index.html'));
fs.copyFileSync(path.join(root, 'client.js'), path.join(publicDirectory, 'client.js'));
fs.cpSync(staticSource, staticDestination, { recursive: true });