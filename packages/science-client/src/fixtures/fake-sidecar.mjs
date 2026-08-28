import http from 'node:http';
import { appendFileSync } from 'node:fs';

if (process.argv.includes('--exit')) process.exit(7);
if (process.argv.includes('--invalid-ready')) {
  process.stdout.write('CORTEXLUME_READY {not-json}\n');
  setInterval(() => {}, 10_000);
}

const token = process.env.CORTEXLUME_TOKEN;
const requestMarkerArgument = process.argv.indexOf('--request-marker');
const requestMarker = requestMarkerArgument >= 0 ? process.argv[requestMarkerArgument + 1] : undefined;
const delayResponseArgument = process.argv.indexOf('--delay-response-ms');
const delayResponseMs = delayResponseArgument >= 0 ? Number(process.argv[delayResponseArgument + 1]) : 0;
const server = http.createServer((request, response) => {
  if (requestMarker) appendFileSync(requestMarker, 'request\n', 'utf8');
  if (request.headers.authorization !== `Bearer ${token}`) {
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }
  if (request.url === '/oversized') {
    response.writeHead(200, { 'content-type': 'application/json', 'content-length': String(16 * 1024 * 1024 + 1) });
    response.end('{}');
    return;
  }
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const sendResponse = () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        ok: true,
        method: request.method,
        payload: chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null,
        assetRoot: process.env.CORTEXLUME_ASSET_DIR,
      }));
    };
    if (delayResponseMs > 0) setTimeout(sendResponse, delayResponseMs);
    else sendResponse();
  });
});

const announceReady = () => server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  process.stdout.write(`CORTEXLUME_READY ${JSON.stringify({ port: address.port })}\n`);
});
const delayReadyArgument = process.argv.indexOf('--delay-ready-ms');
const delayReadyMs = delayReadyArgument >= 0 ? Number(process.argv[delayReadyArgument + 1]) : 10_000;
if (!process.argv.includes('--invalid-ready') && !process.argv.includes('--delay-ready') && delayReadyArgument < 0) announceReady();
if (process.argv.includes('--delay-ready') || delayReadyArgument >= 0) setTimeout(announceReady, delayReadyMs);

process.on('SIGTERM', () => server.close(() => process.exit(0)));
