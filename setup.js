// Build step: fetch the official Xray-core release binary once and
// unpack it next to this file as "web-worker" (plus its geo data files).
// Source: XTLS/Xray-core GitHub releases (official).
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const RELEASE_URL =
  'https://github.com/XTLS/Xray-core/releases/download/v25.10.15/Xray-linux-64.zip';

const dir = __dirname;
const zipPath = path.join(dir, 'xray.zip');
const binPath = path.join(dir, 'web-worker');

function download(url, dest, redirectsLeft) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'sync-service-setup' } }, (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) return reject(new Error('too many redirects'));
          return resolve(download(res.headers.location, dest, redirectsLeft - 1));
        }
        if (status !== 200) {
          res.resume();
          return reject(new Error('download failed: HTTP ' + status));
        }
        const out = fs.createWriteStream(dest);
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve()));
        out.on('error', reject);
      })
      .on('error', reject);
  });
}

async function main() {
  const geoip = path.join(dir, 'geoip.dat');
  if (fs.existsSync(binPath) && fs.existsSync(geoip)) {
    console.log('setup: already present, skipping');
    return;
  }
  await download(RELEASE_URL, zipPath, 5);
  execFileSync('unzip', ['-o', '-q', 'xray.zip'], { cwd: dir, stdio: 'inherit' });
  fs.renameSync(path.join(dir, 'xray'), binPath);
  fs.chmodSync(binPath, 0o755);
  for (const junk of ['xray.zip', 'LICENSE', 'README.md']) {
    try { fs.unlinkSync(path.join(dir, junk)); } catch (_) { /* ignore */ }
  }
  for (const needed of ['geoip.dat', 'geosite.dat']) {
    if (!fs.existsSync(path.join(dir, needed))) {
      throw new Error('setup: missing ' + needed + ' after unpack');
    }
  }
  console.log('setup: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
