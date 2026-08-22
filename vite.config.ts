import { defineConfig } from 'vite';
import { resolve } from 'node:path';
export default defineConfig({ build:{ outDir:'dist', emptyOutDir:true, rollupOptions:{ input:{ serviceWorker:resolve(__dirname,'src/background/service-worker.ts'), content:resolve(__dirname,'src/content/chrome-media.ts'), websocket:resolve(__dirname,'src/offscreen/websocket-client.ts') }, output:{ entryFileNames:'[name].js', format:'es', inlineDynamicImports:false } } } });
