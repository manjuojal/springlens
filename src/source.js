'use strict';
const fs = require('fs');
const path = require('path');

/**
 * Offline-only source resolution: Spring Lens analyzes local folders only.
 * There is intentionally no Git/HTTP fetching - the app never opens an outbound connection.
 */
function parseSource(input) {
  const s = String(input || '').trim().replace(/^["']|["']$/g, '');
  if (!s) throw new Error('Enter the path of a local project folder.');
  if (/^(https?|ssh|git|ftp):\/\//i.test(s) || /^git@/i.test(s) || /^(www\.)?(github|gitlab|bitbucket)\./i.test(s)) {
    throw new Error('Spring Lens runs fully offline and does not download repositories. Clone the project yourself and enter its local folder path.');
  }
  if (!fs.existsSync(s) || !fs.statSync(s).isDirectory()) throw new Error(`Folder not found: ${s}`);
  return { type: 'local', path: path.resolve(s) };
}

async function materialize(src) {
  return { root: src.path, source: src };
}

module.exports = { parseSource, materialize };
