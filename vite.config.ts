import react from '@vitejs/plugin-react'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineConfig, loadEnv, type Plugin } from 'vite'

/**
 * Vite + http-proxy sometimes answers OPTIONS inconsistently relative to DELETE / Bearer / JSON —
 * browsers require a consistent preflight *before* the real request reaches Express.
 */
function apiPreflightPlugin(): Plugin {
  return {
    name: 'api-options-preflight',
    enforce: 'pre',
    configureServer(server) {
      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const pathOnly = String(req.url ?? '').split(/[?#]/)[0] ?? ''
        if (!pathOnly.startsWith('/api')) return next()
        if (req.method !== 'OPTIONS') return next()

        const origin = req.headers.origin as string | undefined
        const reqHdr = req.headers['access-control-request-headers']
        const hdrList =
          typeof reqHdr === 'string' && reqHdr.trim().length > 0
            ? reqHdr
            : 'Authorization, Content-Type'

        res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', hdrList)
        res.setHeader('Access-Control-Max-Age', '86400')

        if (origin) {
          res.setHeader('Access-Control-Allow-Origin', origin)
          res.setHeader('Vary', 'Origin')
          res.setHeader('Access-Control-Allow-Credentials', 'true')
        } else {
          res.setHeader('Access-Control-Allow-Origin', '*')
        }

        res.statusCode = 204
        res.setHeader('Content-Length', '0')
        res.end()
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiPort = env.PORT?.trim() || '8787'
  /** Prefer IPv4 — on Windows `localhost` can resolve to IPv6 first while Express listens IPv4-first. */
  const apiOrigin = `http://127.0.0.1:${apiPort}`

  /**
   * Vite 8 default `server.cors` only allows localhost / 127.0.0.1 / ::1. If you open the dev server
   * as `http://192.168.*:5173`, `--host`, or a tunnel hostname, preflight OPTIONS fails on requests
   * with Authorization + JSON — DELETE/POST silently never reach the API. Reflect any dev origin instead.
   */
  const permissiveDevCors = {
    origin: true as const,
    credentials: true,
    allowedHeaders: ['Authorization', 'Content-Type'],
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  };

  return {
    plugins: [apiPreflightPlugin(), react()],
    server: {
      cors: permissiveDevCors,
      proxy: {
        '/api': {
          target: apiOrigin,
          changeOrigin: true,
          /** Schedule can re-encode long Shorts splits — avoid proxy closing the browser request early. */
          timeout: 900_000,
          proxyTimeout: 900_000,
        },
      },
    },
    preview: {
      cors: permissiveDevCors,
      proxy: {
        '/api': {
          target: apiOrigin,
          changeOrigin: true,
          timeout: 900_000,
          proxyTimeout: 900_000,
        },
      },
    },
  }
})
