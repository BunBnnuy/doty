import http from 'node:http';
import net from 'node:net';
import { lookup } from 'node:dns/promises';
import { pathToFileURL } from 'node:url';

export function isPublicIPv4(ip) {
  if (net.isIP(ip) !== 4) return false;
  const [a, b, c] = ip.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 192 && b === 0 && c === 2) || (a === 203 && b === 0 && c === 113));
}

async function destination(host) {
  const addresses = await lookup(host, { all: true, family: 4 });
  const blocked = new Set((process.env.BLOCKED_IPS || '').split(','));
  if (!addresses.length || addresses.some(({ address }) => !isPublicIPv4(address) || blocked.has(address))) {
    throw new Error('Blocked destination');
  }
  return addresses[0].address; // Pin the checked address for this connection.
}

export function createProxy() {
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url);
    if (url.protocol !== 'http:' || (url.port && url.port !== '80')) throw new Error('Blocked port');
    const ip = await destination(url.hostname);
    const headers = { ...req.headers, host: url.host };
    delete headers['proxy-authorization'];
    const upstream = http.request({ host: ip, port: 80, path: url.pathname + url.search,
      method: req.method, headers, timeout: 30_000 }, (answer) => {
      res.writeHead(answer.statusCode || 502, answer.headers);
      answer.pipe(res);
    });
    upstream.on('timeout', () => upstream.destroy());
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.on('aborted', () => upstream.destroy());
    req.pipe(upstream);
  } catch { res.writeHead(403); res.end('Destination not permitted'); }
});

server.on('connect', async (req, socket, head) => {
  socket.on('error', () => socket.destroy());
  try {
    const url = new URL(`https://${req.url}`);
    if (url.port && url.port !== '443') throw new Error('Blocked port');
    const ip = await destination(url.hostname);
    const upstream = net.connect({ host: ip, port: 443 });
    upstream.setTimeout(60_000, () => upstream.destroy());
    upstream.on('connect', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
  } catch { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); }
});
return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) createProxy().listen(8080, '0.0.0.0');
