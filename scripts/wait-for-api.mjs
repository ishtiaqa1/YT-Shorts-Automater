/**
 * Blocks until `GET /api/health` returns 200 so Vite’s proxy does not race a slow API boot (DB init, etc.).
 */
import 'dotenv/config';
import http from 'node:http';

const port = Number(process.env.PORT || 8787);
const host = '127.0.0.1';
const path = '/api/health';
const maxMs = Math.max(5000, Number(process.env.WAIT_FOR_API_MS || 120_000));
const start = Date.now();

function tryOnce() {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path, timeout: 2500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function main() {
  process.stdout.write(`[wait-for-api] Waiting for http://${host}:${port}${path} …\n`);
  while (Date.now() - start < maxMs) {
    if (await tryOnce()) {
      process.stdout.write(`[wait-for-api] Ready (${Date.now() - start}ms)\n`);
      process.exit(0);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  process.stderr.write(
    `[wait-for-api] Timed out after ${maxMs}ms — check Postgres (DATABASE_URL), PORT, and the API terminal.\n`
  );
  process.exit(1);
}

await main();
