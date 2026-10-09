import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPublicIPv4, createProxy } from './egress.mjs';
test('reject private, loopback, metadata, reserved, and IPv6 destinations', () => {
  for (const ip of ['127.0.0.1','10.0.0.1','172.16.0.1','192.168.1.1','169.254.169.254',
    '100.64.0.1','0.0.0.0','224.0.0.1','198.18.0.1','192.0.2.1','198.51.100.1','203.0.113.1','::1','::ffff:127.0.0.1']) {
    assert.equal(isPublicIPv4(ip), false, ip);
  }
  assert.equal(isPublicIPv4('1.1.1.1'), true);
});
test('proxy denies a private HTTP URL before opening a connection', async () => {
  const server = createProxy();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const { request } = await import('node:http');
  try {
    const status = await new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: address.port, path: 'http://127.0.0.1/' }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(status, 403);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
