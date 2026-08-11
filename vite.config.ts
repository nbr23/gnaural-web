/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  // A build stamp the running app can show. With `registerType: 'prompt'` an installed PWA keeps
  // serving the previous build until every client closes, so "which build is this phone actually
  // running?" is a question that needs an answer on screen.
  define: {
    __BUILD_ID__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ')),
  },
  plugins: [
    react(),
    VitePWA({
      // `prompt`, not `autoUpdate`. `autoUpdate` claims open clients with a new service worker
      // whose precache no longer holds the program chunk the page is about to lazily import
      // (src/library/programs.ts) — a 404 mid-session. Waiting means the old worker keeps serving
      // a consistent build until every tab is gone. The update prompt itself is step 9; nothing
      // here imports `virtual:pwa-register`, which also keeps that module out of the test run.
      registerType: 'prompt',
      injectRegister: 'auto',
      workbox: {
        // The 19 bundled programs are each their own chunk, so `**/*.js` precaches the whole
        // library — no extra configuration, and the app is fully usable offline. The manifest and
        // its icons are added by the plugin itself; globbing them too would only duplicate them.
        globPatterns: ['**/*.{js,css,html}'],
        navigateFallback: 'index.html',
      },
      manifest: {
        name: 'Gnaural Web',
        short_name: 'Gnaural',
        description:
          'Play, export and share Gnaural binaural-beat programs. Works offline; nothing leaves your device.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        // Not locked to portrait: the schedule chart reads well wide.
        orientation: 'any',
        background_color: '#16171d',
        theme_color: '#16171d',
        categories: ['health', 'lifestyle', 'music'],
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
      },
    }),
  ],
  test: {
    environment: 'happy-dom',
    setupFiles: ['./src/test-setup.ts'],
  },
})
