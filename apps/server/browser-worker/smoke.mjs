// Deploy-time test. Auth is supplied through the process environment.
const root = process.env.BROWSER_WORKER_URL || 'http://127.0.0.1:8890';
const headers = { authorization: `Bearer ${process.env.BROWSER_WORKER_TOKEN}`, 'content-type': 'application/json' };
const request = async (path, body) => {
  const result = await fetch(root + path, { headers, method: body ? 'POST' : 'GET',
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000) });
  if (!result.ok) throw new Error(`Browser smoke ${path}: ${result.status}`);
  return result;
};
let ready = false;
for (let attempt = 0; attempt < 30; attempt++) {
  try { await request('/health'); ready = true; break; } catch { await new Promise(r => setTimeout(r, 2000)); }
}
if (!ready) throw new Error('Browser failed to start; inspect the container log');
const unauthenticated = await fetch(root + '/health');
if (unauthenticated.status !== 401) throw new Error('Worker authentication failed');
await request('/action', { action: 'navigate', url: 'https://example.com' });
let found = false;
for (let attempt = 0; attempt < 10; attempt++) {
  const snapshot = await (await request('/snapshot')).json();
  if (JSON.stringify(snapshot).includes('Example Domain')) { found = true; break; }
  await new Promise(r => setTimeout(r, 1000));
}
if (!found) throw new Error('Public web navigation failed');
const png = Buffer.from(await (await request('/screenshot')).arrayBuffer());
if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || png.readUInt32BE(16) !== 1280 || png.readUInt32BE(20) !== 720)
  throw new Error('Desktop screenshot failed');
await request('/action', { action: 'scroll', direction: 'down' });
await request('/action', { action: 'click', x: 100, y: 120 });
await request('/action', { action: 'key', key: 'ctrl+l' });
await request('/action', { action: 'type', text: 'https://example.net' });
await request('/action', { action: 'key', key: 'Return' });
let typedNavigation = false;
for (let attempt = 0; attempt < 10; attempt++) {
  const snapshot = await (await request('/snapshot')).json();
  if (snapshot.url?.startsWith('https://example.net') && JSON.stringify(snapshot.nodes).includes('Example Domain')) {
    typedNavigation = true; break;
  }
  await new Promise(r => setTimeout(r, 1000));
}
if (!typedNavigation) throw new Error('Desktop key or text input failed');
console.log('browser smoke: auth, HTTPS navigation, accessibility, 1280x720 screenshot, click, scroll, typing and keys passed');
