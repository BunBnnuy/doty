import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
const MAX_BYTES = 10 * 1024 * 1024;
export function imageMime(data) {
  if (data.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'image/png';
  if (data.subarray(0, 3).toString('hex') === 'ffd8ff') return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString())) return 'image/gif';
  if (data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  throw new Error('Not a supported raster image');
}
export function publicURL(raw) {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 4096 ||
    (url.port && url.port !== (url.protocol === 'https:' ? '443' : '80'))) throw new Error('Unsupported image URL');
  return url;
}
export function inlineImage(raw) {
  if (typeof raw !== 'string' || raw.length > 700_000 || !/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(raw))
    throw new Error('Unsupported embedded image');
  const data = Buffer.from(raw.slice(raw.indexOf(',') + 1), 'base64');
  return { data, mime: imageMime(data), preview: true };
}
async function tunnel(url, proxy, timeout) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: proxy.hostname, port: proxy.port, method: 'CONNECT', path: `${url.hostname}:443`, timeout });
    request.on('connect', (response, socket, head) => {
      if (response.statusCode !== 200) { socket.destroy(); reject(new Error('Image destination blocked')); return; }
      if (head.length) socket.unshift(head);
      resolve(socket);
    });
    request.on('timeout', () => request.destroy(new Error('Image timeout')));
    request.on('error', reject); request.end();
  });
}
export async function downloadPublicImage(raw, proxyURL = 'http://egress:8080', timeoutMs = 12_000) {
  const proxy = new URL(proxyURL);
  const deadline = Date.now() + timeoutMs;
  let url = publicURL(raw);
  for (let redirects = 0; redirects <= 3; redirects++) {
    let agent;
    if (url.protocol === 'https:') {
      const socket = await tunnel(url, proxy, Math.max(1, deadline - Date.now()));
      agent = new https.Agent();
      agent.createConnection = () => tls.connect({ socket, servername: url.hostname });
    }
    try {
      const response = await new Promise((resolve, reject) => {
        const secure = url.protocol === 'https:';
        const request = (secure ? https : http).request({
          host: secure ? url.hostname : proxy.hostname, port: secure ? 443 : proxy.port,
          path: secure ? url.pathname + url.search : url.href, ...(agent ? { agent } : {}),
          headers: { host: url.host, 'user-agent': 'Doty/0.1', accept: 'image/*' },
        }, answer => {
          if ([301, 302, 303, 307, 308].includes(answer.statusCode)) {
            answer.resume(); resolve({ redirect: answer.headers.location }); return;
          }
          if (answer.statusCode !== 200 || Number(answer.headers['content-length']) > MAX_BYTES) {
            answer.destroy(); reject(new Error('Image download unavailable')); return;
          }
          const chunks = []; let size = 0;
          answer.on('data', chunk => {
            size += chunk.length;
            if (size > MAX_BYTES) request.destroy(new Error('Image exceeds 10 MiB')); else chunks.push(chunk);
          });
          answer.on('end', () => resolve({ data: Buffer.concat(chunks) }));
          answer.on('error', reject);
        });
        const timer = setTimeout(() => request.destroy(new Error('Image timeout')), Math.max(1, deadline - Date.now()));
        request.on('close', () => clearTimeout(timer)); request.on('error', reject); request.end();
      });
      if (response.redirect) { url = publicURL(new URL(response.redirect, url).href); continue; }
      return { data: response.data, mime: imageMime(response.data) };
    } finally { agent?.destroy(); }
  }
  throw new Error('Image redirect limit');
}

/** A search thumbnail is the same observed result, not a model-generated substitute. */
export async function downloadObservedImage(candidate, proxyURL = 'http://egress:8080') {
  if (candidate.url?.startsWith('data:')) return inlineImage(candidate.url);
  try { return await downloadPublicImage(candidate.url, proxyURL, 5000); }
  catch (error) {
    if (!candidate.preview || candidate.preview === candidate.url) throw error;
    return candidate.preview.startsWith('data:') ? inlineImage(candidate.preview)
      : { ...await downloadPublicImage(candidate.preview, proxyURL, 7500), preview: true };
  }
}
