import { defineConfig, loadEnv, type ProxyOptions } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const geminiKey = env.GEMINI_API_KEY?.trim()
  const openAiKey = env.OPENAI_API_KEY?.trim()
  const livePriceProxyTarget = env.LIVE_PRICE_PROXY_TARGET?.trim()

  const proxy: Record<string, string | ProxyOptions> = {
    '/proxy-catbox-upload': {
      target: 'https://catbox.moe',
      changeOrigin: true,
      rewrite: () => '/user/api.php',
    },
  }

  if (livePriceProxyTarget) {
    proxy['/proxy-live-pricing'] = {
      target: livePriceProxyTarget,
      changeOrigin: true,
      rewrite: (path) => path.replace(/^\/proxy-live-pricing/, ''),
    }
  }

  if (openAiKey) {
    proxy['/proxy-openai'] = {
      target: 'https://api.openai.com',
      changeOrigin: true,
      rewrite: (path) => path.replace(/^\/proxy-openai/, ''),
      headers: {
        Authorization: `Bearer ${openAiKey}`,
      },
    }
  }

  if (geminiKey) {
    proxy['/proxy-gemini'] = {
      target: 'https://generativelanguage.googleapis.com',
      changeOrigin: true,
      rewrite: (path) => path.replace(/^\/proxy-gemini/, '/v1beta'),
      headers: {
        'x-goog-api-key': geminiKey,
      },
    }
  }

  return {
    plugins: [react()],
    server: {
      proxy,
    },
  }
})
