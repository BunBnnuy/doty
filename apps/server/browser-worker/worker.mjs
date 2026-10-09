import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, timingSafeEqual } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { downloadObservedImage, publicURL, inlineImage } from './images.mjs';
import { CDP, BrowserFailure, retryRead, waitForPage } from './reliability.mjs';
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
  if (result.exceptionDetails) throw new BrowserFailure('CDP_CONTEXT_LOST', 'Runtime.evaluate');
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
let screenshotFlight;
function screenshot() {
  if (!screenshotFlight) screenshotFlight = captureScreenshot().finally(() => { screenshotFlight = undefined; });
  return screenshotFlight;
}
async function captureScreenshot() {
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
  let navigation;
  if (input.action === 'navigate') {
    const url = new URL(input.url);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.href.length > 4096)
      throw new Error('Only public web URLs are permitted');
    navigation = await cdp.call('Page.navigate', { url: url.href });
  } else if (input.action === 'search') {
    if (typeof input.query !== 'string' || !input.query.trim() || input.query.length > 1000) throw new Error('Invalid query');
    const url = new URL('https://www.google.com/search');
    url.searchParams.set('q', input.query);
    if (input.images) url.searchParams.set('udm', '2');
    navigation = await cdp.call('Page.navigate', { url: url.href });
  } else if (input.action === 'open_link') {
    const history = await cdp.call('Page.getNavigationHistory');
    if (history.entries[history.currentIndex]?.url !== observedURL || !Number.isInteger(input.id) || !observedLinks[input.id])
      throw new Error('Stale or invalid link');
    navigation = await cdp.call('Page.navigate', { url: observedLinks[input.id].url });
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
  if (navigation) {
    if (navigation.errorText) throw new BrowserFailure('NAVIGATION_FAILED', 'Page.navigate');
    try { await waitForPage(cdp, 12_000, navigation.loaderId); }
    catch (error) {
      if (error.code !== 'PAGE_LOADING') throw error;
      // Navigation already happened. Let the next read recover; never send it twice.
      return { ok: true, pageReady: false };
    }
  }
  else await new Promise((r) => setTimeout(r, 250));
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
      const deadline = Date.now() + 30_000;
      const snapshot = await retryRead(async () => {
        if (Date.now() >= deadline) throw new BrowserFailure('PAGE_LOADING');
        await waitForPage(cdp, Math.min(12_000, deadline - Date.now()));
        const before = await cdp.call('Page.getFrameTree');
        const tree = await cdp.call('Accessibility.getFullAXTree');
        const history = await cdp.call('Page.getNavigationHistory');
        const page = history.entries[history.currentIndex];
        const items = await observation();
        const after = await cdp.call('Page.getFrameTree');
        if (before.frameTree.frame.loaderId !== after.frameTree.frame.loaderId) throw new BrowserFailure('CDP_CONTEXT_LOST');
        observedURL = page?.url;
        const nodes = tree.nodes.filter(node => !node.ignored && node.name?.value)
          .slice(0, 200).map(node => ({ role: node.role?.value, name: String(node.name.value).slice(0, 500) }));
        return { url: page?.url, title: page?.title, nodes, ...items };
      });
      res.end(JSON.stringify(snapshot)); return;
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
  } catch (error) {
    const code = error instanceof BrowserFailure ? error.code : 'WORKER_OPERATION_FAILED';
    const operation = ['/health', '/screenshot', '/snapshot', '/action', '/image'].includes(req.url) ? req.url : 'unknown';
    console.error(JSON.stringify({ event: 'browser_worker_error', operation, code,
      ...(error instanceof BrowserFailure ? { method: error.method, protocolCode: error.protocolCode } : {}) }));
    res.writeHead(503); res.end(JSON.stringify({ error: code }));
  }
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
