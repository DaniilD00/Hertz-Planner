import { defineConfig } from 'vite';
import { createApi } from './server/api.mjs';

// `npm run build:pages` (Vite mode "pages") builds the GitHub Pages version: no server, relative paths
// so it works under https://<user>.github.io/<repo>/.
export default defineConfig(({ mode }) => ({
  base: mode === 'pages' ? './' : '/',
  plugins: [
    {
      name: 'hertz-planner-api',
      configureServer(server) {
        const api = createApi({ cacheDir: 'cache' });
        server.middlewares.use((req, res, next) => {
          void api(req, res, next);
        });
      },
    },
  ],
  server: { port: 5173, open: true },
  build: { chunkSizeWarningLimit: 1500 },
}));
