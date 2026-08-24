import http from 'node:http';

if (process.argv.includes('--exit')) process.exit(7);
if (process.argv.includes('--invalid-ready')) {
  process.stdout.write('CORTEXLUME_READY {not-json}\n');
  setInterval(() => {}, 10_000);
}

const token = process.env.CORTEXLUME_TOKEN;
const server = http.createServer((request, response) => {
  if (request.headers.authorization !== `Bearer ${token}`) {
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      ok: true,
      method: request.method,
      payload: chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null,
      assetRoot: process.env.CORTEXLUME_ASSET_DIR,
    }));
  });
});

if (!process.argv.includes('--invalid-ready')) server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  process.stdout.write(`CORTEXLUME_READY ${JSON.stringify({ port: address.port })}\n`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
