import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Used only when the "useProxy" setting is on (CORS workaround, spec 12.1).
      '/gemini': {
        target: 'https://generativelanguage.googleapis.com',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/gemini/, ''),
      },
    },
  },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
