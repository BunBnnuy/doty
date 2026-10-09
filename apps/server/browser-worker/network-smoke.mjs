import net from 'node:net';
import http from 'node:http';
const connected = (host, port) => new Promise(resolve => {
  const socket = net.connect({ host, port });
  const finish = result => { socket.destroy(); resolve(result); };
  socket.setTimeout(2000, () => finish(false)); socket.on('error', () => finish(false)); socket.on('connect', () => finish(true));
});
if (await connected('1.1.1.1', 443)) throw new Error('Worker has direct internet access');
if (await connected(process.env.BROWSER_HOST_GATEWAY, 8787)) throw new Error('Worker can reach the host API');
for (const url of ['http://127.0.0.1/', 'http://169.254.169.254/', `http://${process.env.BROWSER_HOST_GATEWAY}/`]) {
  const status = await new Promise((resolve, reject) => {
    const request = http.request({ host: 'egress', port: 8080, path: url, timeout: 5000 }, response => { response.resume(); resolve(response.statusCode); });
    request.on('timeout', () => request.destroy()); request.on('error', reject); request.end();
  });
  if (status !== 403) throw new Error('Proxy private address protection failed');
}
console.log('browser network smoke: direct internet, host API, loopback and metadata access blocked');
