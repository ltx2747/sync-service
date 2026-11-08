// Entry point: a small gateway in front of the Xray core.
//
//   - The platform edge terminates TLS on 443 and forwards plain HTTP
//     to this process on $PORT.
//   - WebSocket traffic on $WSPATH is proxied to Xray on 127.0.0.1:10000
//     (VLESS + WS, credentials from env).
//   - A Clash subscription (full rule-based config, template in
//     subscription.yaml) is served at /sub-$SUB_SECRET when SUB_SECRET
//     is set. All credentials come from environment variables; the
//     repository itself contains none.
//   - Everything else gets a plain 404.
//
// Env: UUID (required), WSPATH, PORT (platform), SUB_SECRET,
//      CLOADY_UUID, CLOADY_PATH (optional second node for the config).
'use strict';

const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const uuid = process.env.UUID || process.env.APP_KEY;
const wsPath = process.env.WSPATH || process.env.API_ROUTE || '/api/v1/sync';
const port = Number.parseInt(process.env.PORT || '8080', 10);
const subSecret = process.env.SUB_SECRET || '';
const cloadyUuid = process.env.CLOADY_UUID || '';
const cloadyPath = process.env.CLOADY_PATH || '';

const XRAY_PORT = 10000;

if (!uuid) {
  console.error('UUID env var is required');
  process.exit(1);
}

// ---------------------------------------------------------------- Xray core

const binPath = path.join(__dirname, 'web-worker');
if (!fs.existsSync(binPath)) {
  execFileSync('node', ['setup.js'], { cwd: __dirname, stdio: 'inherit' });
}

const xrayConfig = {
  log: { loglevel: 'warning' },
  inbounds: [
    {
      listen: '127.0.0.1',
      port: XRAY_PORT,
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
fs.writeFileSync(cfgPath, JSON.stringify(xrayConfig));

const child = spawn(binPath, ['run', '-c', cfgPath], {
  cwd: __dirname,
  stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code == null ? 0 : code));

// ------------------------------------------------------- subscription (YAML)

function renderSubscription() {
  const tplPath = path.join(__dirname, 'subscription.yaml');
  if (!subSecret || !fs.existsSync(tplPath)) return null;
  let text = fs.readFileSync(tplPath, 'utf8');
  text = text.split('__PXXL_UUID__').join(uuid);
  text = text.split('__PXXL_PATH__').join(wsPath);
  if (cloadyUuid && cloadyPath) {
    text = text.split('__CLOADY_UUID__').join(cloadyUuid);
    text = text.split('__CLOADY_PATH__').join(cloadyPath);
  } else {
    // Drop the cloady proxy block and its group references.
    const lines = text.split('\n');
    const out = [];
    let inCloadyBlock = false;
    for (const line of lines) {
      if (line.startsWith('  - name: cloady-usw1')) {
        inCloadyBlock = true;
        continue;
      }
      if (inCloadyBlock) {
        if (line.startsWith('  - name: ')) inCloadyBlock = false;
        else continue;
      }
      if (/^\s+- cloady-usw1\s*$/.test(line)) continue;
      out.push(line);
    }
    text = out.join('\n');
  }
  return text;
}

const subBody = renderSubscription();
const subPath = subSecret ? '/sub-' + subSecret : null;
if (subPath && subBody) console.log('subscription endpoint enabled');
if (subPath && !subBody) console.log('subscription template missing; endpoint off');

// ------------------------------------------------------------------ gateway

const server = http.createServer((req, res) => {
  const pathname = (req.url || '').split('?')[0];

  if (subPath && subBody && req.method === 'GET' && pathname === subPath) {
    res.writeHead(200, {
      'Content-Type': 'text/yaml; charset=utf-8',
      'Cache-Control': 'no-store',
      'profile-update-interval': '24',
    });
    res.end(subBody);
    return;
  }

  if (pathname === wsPath) {
    // Plain (non-upgrade) HTTP on the WS path: forward to Xray as-is.
    const upstream = http.request(
      { host: '127.0.0.1', port: XRAY_PORT, path: req.url, method: req.method, headers: req.headers },
      (up) => {
        res.writeHead(up.statusCode || 502, up.headers);
        up.pipe(res);
      }
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found\n');
});

server.on('upgrade', (req, socket, head) => {
  const pathname = (req.url || '').split('?')[0];
  if (pathname !== wsPath) {
    socket.destroy();
    return;
  }
  const upstream = net.connect(XRAY_PORT, '127.0.0.1', () => {
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

server.listen(port, '0.0.0.0', () => {
  console.log('gateway listening on ' + port);
});

process.on('SIGTERM', () => child.kill('SIGTERM'));
process.on('SIGINT', () => child.kill('SIGINT'));
