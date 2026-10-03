import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // Read the repo-level .env (all keys, not only VITE_*), so the proxy can use API_TOKEN.
  const env = loadEnv(mode, '..', '');
  // The API port must match PORT in the root .env (default 3001).
  const apiTarget = env.VITE_API_PROXY || `http://localhost:${env.PORT || 3001}`;
  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: true,
          // The token is added here, on the dev server, so it never reaches the browser.
          ...(env.API_TOKEN && { headers: { Authorization: `Bearer ${env.API_TOKEN}` } }),
        },
      },
    },
  };
});
