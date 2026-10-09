import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { downloadPublicImage, imageMime, publicURL } from './images.mjs';
const png = Buffer.from('89504e470d0a1a0a', 'hex');
test('only raster signatures and normal HTTP(S) image URLs are accepted', () => {
  assert.equal(imageMime(png), 'image/png');
  assert.throws(() => imageMime(Buffer.from('<svg/>')));
  for (const url of ['file:///tmp/image.png', 'data:image/png;base64,AAA', 'https://u:p@example.com/a', 'http://example.com:8787/a'])
    assert.throws(() => publicURL(url));
});
test('image downloads go through the proxy, follow checked redirects, and reject HTML and oversized files', async () => {
  const seen = [];
  const proxy = http.createServer((req, res) => {
    seen.push(req.url);
    if (req.url.endsWith('/redirect')) { res.writeHead(302, { location: '/image' }); res.end(); }
    else if (req.url.endsWith('/large')) { res.writeHead(200, { 'content-length': 11 * 1024 * 1024 }); res.end(); }
    else if (req.url.endsWith('/html')) res.end('<html>Not an image</html>');
    else res.end(png);
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const address = `http://127.0.0.1:${proxy.address().port}`;
  try {
    assert.deepEqual(await downloadPublicImage('http://images.example/redirect', address), { data: png, mime: 'image/png' });
    assert.deepEqual(seen, ['http://images.example/redirect', 'http://images.example/image']);
    await assert.rejects(downloadPublicImage('http://images.example/html', address));
    await assert.rejects(downloadPublicImage('http://images.example/large', address));
  } finally { await new Promise(resolve => proxy.close(resolve)); }
});
