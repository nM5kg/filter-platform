// Local test-only relay: the sandbox egress proxy drops unauthenticated
// connections without a 407 challenge, and Chromium only sends
// Proxy-Authorization after a 407. This relay adds the Authorization
// header pre-emptively and forwards to the egress proxy. Production
// scanner containers have direct internet and need no relay.
// Credentials come from the environment; nothing is logged.
const http = require('http');
const net = require('net');

const upstream = new URL(process.env.HTTPS_PROXY || process.env.HTTP_PROXY);
const UP_HOST = '198.19.0.1'; // IPv4 for hatch-egress-proxy (also has IPv6)
const UP_PORT = Number(upstream.port || 3128);
const AUTH = 'Basic ' + Buffer.from(
  decodeURIComponent(upstream.username) + ':' + decodeURIComponent(upstream.password)
).toString('base64');
const LISTEN_PORT = Number(process.env.RELAY_PORT || 18080);

const server = http.createServer((req, res) => {
  // Plain-HTTP forward: absolute-form URL expected from a proxy client.
  const target = new URL(req.url);
  const headers = { ...req.headers, 'proxy-authorization': AUTH };
  delete headers['proxy-connection'];
  const opts = {
    host: UP_HOST, port: UP_PORT, method: req.method, path: req.url, headers,
  };
  const up = http.request(opts, (upRes) => {
    res.writeHead(upRes.statusCode, upRes.headers);
    upRes.pipe(res);
  });
  up.on('error', () => { try { res.writeHead(502); res.end('relay upstream error'); } catch {} });
  up.setTimeout(30_000, () => up.destroy(new Error('upstream timeout')));
  req.on('close', () => up.destroy());
  req.pipe(up);
});

server.on('connect', (req, socket) => {
  // CONNECT target:443 -> open TCP to egress proxy, send CONNECT with auth.
  let established = false;
  let buf = Buffer.alloc(0);
  const upstreamSock = net.connect(UP_PORT, UP_HOST);
  const establishTimer = setTimeout(() => {
    if (!established) {
      try { socket.end('HTTP/1.1 504 Gateway Timeout\r\n\r\n'); } catch {}
      upstreamSock.destroy();
    }
  }, 15_000);
  const cleanup = () => clearTimeout(establishTimer);
  upstreamSock.on('connect', () => {
    upstreamSock.write(
      `CONNECT ${req.url} HTTP/1.1\r\nHost: ${req.url}\r\nProxy-Authorization: ${AUTH}\r\nProxy-Connection: keep-alive\r\n\r\n`
    );
  });
  upstreamSock.on('data', (chunk) => {
    if (established) return;
    buf = Buffer.concat([buf, chunk]);
    const end = buf.indexOf('\r\n\r\n');
    if (end === -1) return;
    const head = buf.slice(0, end).toString();
    if (!/^HTTP\/1\.[01] 200/.test(head)) {
      cleanup();
      socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      upstreamSock.destroy();
      return;
    }
    established = true;
    cleanup();
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    const rest = buf.slice(end + 4);
    // Bytes after the 200 headers are the start of the tunneled TLS
    // stream from the target server: forward to the CLIENT, never
    // back upstream (an earlier version wrote them to upstreamSock,
    // corrupting tunnels whose 200 + first TLS bytes arrived together).
    if (rest.length) socket.write(rest);
    upstreamSock.pipe(socket);
    socket.pipe(upstreamSock);
  });
  upstreamSock.on('error', () => { cleanup(); if (!established) { try { socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch {} } });
  upstreamSock.on('close', () => { cleanup(); if (!socket.destroyed) socket.destroy(); });
  socket.on('error', () => { cleanup(); upstreamSock.destroy(); });
  socket.on('close', () => { cleanup(); upstreamSock.destroy(); });
});

server.listen(LISTEN_PORT, '127.0.0.1', () => {
  console.log('relay listening on 127.0.0.1:' + LISTEN_PORT);
});
