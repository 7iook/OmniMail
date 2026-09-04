import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const workerOrigin = (env.VITE_API_ORIGIN || 'http://127.0.0.1:8787').replace(/\/$/, '')
  const devPort = Number(env.VITE_DEV_PORT) || 5173

  return {
    plugins: [react()],
    server: {
      port: devPort,
      strictPort: true,
      proxy: {
        '/api': {
          target: workerOrigin,
          changeOrigin: true,
          headers: {
            Origin: workerOrigin,
          },
        },
      },
    },
  }
})
