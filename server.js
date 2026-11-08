// Start step: build an Xray config from environment variables and run
// the core binary (downloaded by setup.js) as a child process.
//   UUID   (required) client id for the VLESS inbound
//   WSPATH WebSocket path, must start with "/" (default "/api/v1/sync")
//   PORT   listen port injected by the platform (default 8080)
// Traffic: VLESS + WebSocket, plaintext inside the container; the
// platform edge terminates TLS on 443.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const uuid = process.env.UUID || process.env.APP_KEY;
const wsPath = process.env.WSPATH || process.env.API_ROUTE || '/api/v1/sync';
const port = Number.parseInt(process.env.PORT || '8080', 10);

if (!uuid) {
  console.error('UUID env var is required');
  process.exit(1);
}

const binPath = path.join(__dirname, 'web-worker');
if (!fs.existsSync(binPath)) {
  execFileSync('node', ['setup.js'], { cwd: __dirname, stdio: 'inherit' });
}

const config = {
  log: { loglevel: 'warning' },
  inbounds: [
    {
      listen: '0.0.0.0',
      port,
      protocol: 'vless',
      settings: { clients: [{ id: uuid }], decryption: 'none' },
      streamSettings: { network: 'ws', wsSettings: { path: wsPath } },
      sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'] },
    },
  ],
  outbounds: [
    { protocol: 'freedom', tag: 'direct', settings: { domainStrategy: 'UseIPv4' } },
    { protocol: 'blackhole', tag: 'blocked' },
  ],
  routing: {
    domainStrategy: 'IPIfNonMatch',
    rules: [
      { type: 'field', outboundTag: 'blocked', protocol: ['bittorrent'] },
      { type: 'field', outboundTag: 'blocked', ip: ['geoip:private'] },
      { type: 'field', outboundTag: 'blocked', domain: ['geosite:private'] },
    ],
  },
  dns: {
    servers: ['https://1.1.1.1/dns-query', 'https://8.8.8.8/dns-query'],
    queryStrategy: 'UseIPv4',
  },
};

const cfgPath = path.join(
  os.tmpdir(),
  'sync-service-' + crypto.randomBytes(4).toString('hex') + '.json'
);
fs.writeFileSync(cfgPath, JSON.stringify(config));

const child = spawn(binPath, ['run', '-c', cfgPath], {
  cwd: __dirname,
  stdio: 'inherit',
});

child.on('exit', (code) => process.exit(code == null ? 0 : code));
process.on('SIGTERM', () => child.kill('SIGTERM'));
process.on('SIGINT', () => child.kill('SIGINT'));
