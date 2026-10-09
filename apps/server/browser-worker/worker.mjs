import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, timingSafeEqual } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { downloadObservedImage, publicURL, inlineImage } from './images.mjs';
const token = process.env.BROWSER_WORKER_TOKEN;
if (!token) throw new Error('Worker authentication is required');
const exec = promisify(execFile);
const children = [];
let browserReady = false;
let shuttingDown = false;
// This worker owns the profile, and deployment stops its old container first.
// Chromium's lock links can survive a container crash or a hostname change.
for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
  try { await unlink(`/home/browser/profile/${name}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const start = (binary, args) => {
  const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', (data) => {
    // Startup is about:blank only. Stop stderr logging before any site is opened.
    if (!browserReady) console.error(`${binary}: ${String(data).slice(0, 4000).replace(/https?:\/\/\S+/g, '[URL]')}`);
  });
  child.on('error', () => process.exit(1));
  child.on('exit', (code, signal) => {
    if (!shuttingDown) { console.error(`${binary} exited (${code ?? signal})`); process.exit(1); }
  });
  children.push(child);
  return child;
};
start('Xvfb', [':99', '-screen', '0', '1280x720x24', '-nolisten', 'tcp']);
await new Promise((r) => setTimeout(r, 1000));
start('openbox', []);
start('chromium', ['--user-data-dir=/home/browser/profile', '--remote-debugging-address=127.0.0.1',
  '--remote-debugging-port=9222', '--no-first-run', '--no-default-browser-check',
  '--disable-dev-shm-usage', '--disable-quic', '--disable-background-networking',
  '--proxy-server=http://egress:8080', '--proxy-bypass-list=<-loopback>',
  '--window-size=1280,720', '--start-maximized', 'about:blank']);

class CDP {
  id = 0; pending = new Map();
  async connect() {
    const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
    const target = targets.find((t) => t.type === 'page');
    if (!target) throw new Error('Browser is not ready');
    if (this.ws?.readyState === 1 && this.target === target.id) return;
    this.ws?.close(); this.target = target.id;
    this.ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Browser connection timeout')), 5000);
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Browser connection failed')); }, { once: true });
    });
    this.ws.addEventListener('message', ({ data }) => {
      const answer = JSON.parse(data);
      const pending = this.pending.get(answer.id);
      if (!pending) return;
      this.pending.delete(answer.id); clearTimeout(pending.timer);
      if (answer.error) pending.reject(new Error('Browser command failed'));
      else pending.resolve(answer.result);
    });
    this.ws.addEventListener('close', () => {
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Browser disconnected')); }
      this.pending.clear();
    });
  }
  async call(method, params = {}) {
    await this.connect();
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Browser command timeout')); }, 10_000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}
const cdp = new CDP();
let observedLinks = [], observedImages = [], observedURL;
async function observation() {
  const frames = await cdp.call('Page.getFrameTree');
  const world = await cdp.call('Page.createIsolatedWorld', { frameId: frames.frameTree.frame.id, worldName: 'doty-observation' });
  const result = await cdp.call('Runtime.evaluate', { contextId: world.executionContextId, returnByValue: true,
    expression: `(() => {
      const links = Array.from(document.querySelectorAll('a[href]')).slice(0, 300).map(a =>
        ({ url: a.href, title: (a.innerText || a.getAttribute('aria-label') || '').slice(0,250) }));
      const images = [];
      for (const a of document.querySelectorAll('a[href]')) {
        try {
          const link = new URL(a.href), original = link.searchParams.get('imgurl');
          if (original) images.push({url:original,preview:a.querySelector('img')?.currentSrc,
            source:link.searchParams.get('imgrefurl') || a.href,title:(a.innerText || a.querySelector('img')?.alt || '').slice(0,250)});
        } catch {}
      }
      for (const img of document.querySelectorAll('img')) images.push({url:img.currentSrc || img.src,
        source:img.closest('a')?.href || location.href,title:img.alt.slice(0,250)});
      return {links,images:images.slice(0,200)};
    })()` });
  const data = result.result?.value || {};
  const unique = (items, max, allowInline = false) => {
    const seen = new Set(), accepted = [];
    for (const item of items || []) {
      try {
        const url = allowInline && typeof item.url === 'string' && item.url.startsWith('data:')
          ? (inlineImage(item.url), item.url) : publicURL(item.url).href;
        let preview;
        try { if (item.preview) preview = allowInline && item.preview.startsWith('data:')
          ? (inlineImage(item.preview), item.preview) : publicURL(item.preview).href; } catch {}
        if (seen.has(url)) continue; seen.add(url);
        accepted.push({ url, title: item.title, source: item.source, ...(preview ? { preview } : {}), id: accepted.length });
        if (accepted.length >= max) break;
      } catch {}
    }
    return accepted;
  };
  observedLinks = unique(data.links, 100); observedImages = unique(data.images, 60, true);
  return { links: observedLinks, images: observedImages.map(item => ({ ...item,
    url: item.url.startsWith('data:') ? 'Embedded page image' : item.url,
    ...(item.preview?.startsWith('data:') ? { preview: 'Embedded page preview' } : {}) })) };
}
async function screenshot() {
  const { stdout } = await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'x11grab',
    '-video_size', '1280x720', '-i', ':99', '-frames:v', '1', '-threads', '1', '-filter_threads', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'],
  { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024, timeout: 10_000 });
  return stdout;
}
const number = (value, max) => {
  if (!Number.isInteger(value) || value < 0 || value > max) throw new Error('Invalid coordinate');
  return String(value);
};
const keys = new Set(['Return', 'Tab', 'Escape', 'BackSpace', 'Delete', 'Up', 'Down', 'Left', 'Right',
  'Home', 'End', 'Page_Up', 'Page_Down', 'ctrl+a', 'ctrl+c', 'ctrl+v', 'ctrl+l']);
export async function action(input) {
  if (!input || typeof input !== 'object') throw new Error('Invalid action');
  if (input.action === 'navigate') {
    const url = new URL(input.url);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.href.length > 4096)
      throw new Error('Only public web URLs are permitted');
    await cdp.call('Page.navigate', { url: url.href });
  } else if (input.action === 'search') {
    if (typeof input.query !== 'string' || !input.query.trim() || input.query.length > 1000) throw new Error('Invalid query');
    const url = new URL('https://www.google.com/search');
    url.searchParams.set('q', input.query);
    if (input.images) url.searchParams.set('udm', '2');
    await cdp.call('Page.navigate', { url: url.href });
  } else if (input.action === 'open_link') {
    const history = await cdp.call('Page.getNavigationHistory');
    if (history.entries[history.currentIndex]?.url !== observedURL || !Number.isInteger(input.id) || !observedLinks[input.id])
      throw new Error('Stale or invalid link');
    await cdp.call('Page.navigate', { url: observedLinks[input.id].url });
  } else if (input.action === 'click') {
    await exec('xdotool', ['mousemove', number(input.x, 1279), number(input.y, 719), 'click', '1']);
  } else if (input.action === 'type') {
    if (typeof input.text !== 'string' || input.text.length > 4000) throw new Error('Invalid text');
    // Keep typed passwords and text out of the process argument list.
    await new Promise((resolve, reject) => {
      const child = execFile('xdotool', ['type', '--clearmodifiers', '--delay', '1', '--file', '-'],
        { timeout: 10_000, maxBuffer: 4096 }, (error) => error ? reject(error) : resolve());
      child.stdin.on('error', reject); child.stdin.end(input.text);
    });
  } else if (input.action === 'key') {
    if (!keys.has(input.key)) throw new Error('Unsupported key');
    await exec('xdotool', ['key', '--clearmodifiers', input.key]);
  } else if (input.action === 'scroll') {
    if (!['up', 'down'].includes(input.direction)) throw new Error('Invalid scroll');
    await exec('xdotool', ['click', '--repeat', '3', input.direction === 'up' ? '4' : '5']);
  } else if (input.action === 'wait') {
    await new Promise((r) => setTimeout(r, 1500));
  } else throw new Error('Unknown action');
  await new Promise((r) => setTimeout(r, 500));
  return { ok: true };
}
const server = http.createServer(async (req, res) => {
  try {
    const candidate = req.headers.authorization?.replace(/^Bearer /, '') || '';
    if (!timingSafeEqual(createHash('sha256').update(candidate).digest(), createHash('sha256').update(token).digest())) {
      res.writeHead(401); res.end(); return;
    }
    if (req.url === '/health') {
      await cdp.connect(); browserReady = true; res.end(JSON.stringify({ ready: true })); return;
    }
    if (req.url === '/screenshot' && req.method === 'GET') {
      const png = await screenshot();
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
      res.end(png); return;
    }
    if (req.url === '/snapshot' && req.method === 'GET') {
      const tree = await cdp.call('Accessibility.getFullAXTree');
      const history = await cdp.call('Page.getNavigationHistory');
      const page = history.entries[history.currentIndex];
      observedURL = page?.url;
      const items = await observation();
      const nodes = tree.nodes.filter((node) => !node.ignored && node.name?.value)
        .slice(0, 200).map((node) => ({ role: node.role?.value, name: String(node.name.value).slice(0, 500) }));
      res.end(JSON.stringify({ url: page?.url, title: page?.title, nodes, ...items })); return;
    }
    if (['/action', '/image'].includes(req.url) && req.method === 'POST') {
      let text = '';
      for await (const chunk of req) {
        text += chunk.toString(); if (text.length > 8192) throw new Error('Action too large');
      }
      const input = JSON.parse(text);
      if (req.url === '/image') {
        const history = await cdp.call('Page.getNavigationHistory');
        if (history.entries[history.currentIndex]?.url !== observedURL || !Number.isInteger(input.id) || !observedImages[input.id])
          throw new Error('Stale or invalid image');
        const image = await downloadObservedImage(observedImages[input.id]);
        res.writeHead(200, { 'content-type': image.mime, 'cache-control': 'no-store',
          'x-doty-image-preview': image.preview ? 'thumbnail' : 'original' }); res.end(image.data); return;
      }
      res.end(JSON.stringify(await action(input))); return;
    }
    res.writeHead(404); res.end();
  } catch { res.writeHead(503); res.end(JSON.stringify({ error: 'Workspace operation failed' })); }
});
server.listen(8890, '0.0.0.0');
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => {
  if (shuttingDown) return;
  shuttingDown = true; server.close();
  children.at(-1)?.kill('SIGTERM');
  await new Promise(resolve => setTimeout(resolve, 1000));
  for (const child of children) child.kill('SIGTERM');
  process.exit(0);
});
