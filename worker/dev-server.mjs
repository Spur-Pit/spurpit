// Local development & integration test server for SPUR (serves spur/site + spur/worker/src/index.js).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from './src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const siteDir = path.resolve(__dirname, '..', 'site');
const port = Number(process.env.PORT || 8788);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

const env = {
  CHAIN_ID: process.env.CHAIN_ID || '4663',
  RH_RPC_URL: process.env.RH_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com',
  PONS_FACTORY: process.env.PONS_FACTORY || '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e',
  PIT_ADDRESS: process.env.PIT_ADDRESS || '',
  SPUR_ADDRESS: process.env.SPUR_ADDRESS || '',
  X_HANDLE: process.env.X_HANDLE || '',
  SITE_DOMAIN: process.env.SITE_DOMAIN || `localhost:${port}`,
  ASSETS: {
    async fetch(req) {
      const u = new URL(req.url);
      let rel = decodeURIComponent(u.pathname);
      if (rel === '/') rel = '/index.html';
      const target = path.resolve(siteDir, '.' + rel);
      if (!target.startsWith(siteDir) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
        return new Response('Not found', { status: 404 });
      }
      const ext = path.extname(target).toLowerCase();
      return new Response(fs.readFileSync(target), {
        status: 200,
        headers: {
          'content-type': MIME[ext] || 'application/octet-stream',
          'cache-control': 'no-store',
        },
      });
    },
  },
};

const server = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const bodyBuf = Buffer.concat(chunks);
    const fullUrl = `http://${req.headers.host || 'localhost:' + port}${req.url}`;
    const webReq = new Request(fullUrl, {
      method: req.method,
      headers: req.headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : bodyBuf,
    });
    const webRes = await worker.fetch(webReq, env);
    res.writeHead(webRes.status, Object.fromEntries(webRes.headers.entries()));
    const ab = await webRes.arrayBuffer();
    res.end(Buffer.from(ab));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e.message || String(e) }));
  }
});

server.listen(port, () => {
  console.log(`SPUR local arena -> http://127.0.0.1:${port}`);
});
