import { defineConfig } from 'vite';

// Le site est construit directement dans le dossier « static » du backend :
// Spring Boot le sert alors tel quel (un seul programme à lancer).
export default defineConfig({
  base: './',
  build: {
    outDir: '../backend/src/main/resources/static',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8080',
    },
  },
});

// GROGNON
