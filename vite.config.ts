import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// Config único do Vite. (Antes existiam vite.config.js e vite.config.ts; o .js
// tinha prioridade e silenciava este ficheiro. Consolidado aqui.)
export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    return {
      server: {
        port: 3000,
        host: '0.0.0.0',
      },
      plugins: [react()],
      define: {
        'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
        'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY)
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      },
      build: {
        // Separa as bibliotecas pesadas em chunks próprios para caching estável
        // e para não inflarem o chunk de entrada. Combinado com o React.lazy das
        // rotas, o arranque só carrega o que é preciso.
        rollupOptions: {
          output: {
            manualChunks: {
              'react-vendor': ['react', 'react-dom', 'react-router-dom'],
              icons: ['lucide-react'],
            },
          },
        },
        chunkSizeWarningLimit: 900,
      }
    };
});
