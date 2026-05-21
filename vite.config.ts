import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  root: '.',
  publicDir: 'public',
  build: {
    outDir: 'dist/public',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,webmanifest}'],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/api\.mapbox\.com\/.*tiles.*/,
            handler: 'CacheFirst',
            options: { cacheName: 'mapbox-tiles-v1', expiration: { maxEntries: 500 } },
          },
          {
            urlPattern: /^https:\/\/[abc]\.tile\.openstreetmap\.org\//,
            handler: 'CacheFirst',
            options: { cacheName: 'osm-tiles-v1', expiration: { maxEntries: 500 } },
          },
          {
            urlPattern: /^https:\/\/[abc]\.tile\.opentopomap\.org\//,
            handler: 'CacheFirst',
            options: { cacheName: 'topo-tiles-v1', expiration: { maxEntries: 500 } },
          },
          {
            urlPattern: /^http:\/\/localhost:3000\/api\//,
            handler: 'NetworkFirst',
            options: { cacheName: 'api-v1' },
          },
        ],
      },
      manifest: false,
    }),
  ],
});
