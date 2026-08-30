import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  // Electron loads packaged HTML files with file:// URLs, so assets must
  // resolve relative to each HTML file rather than from the filesystem root.
  base: './',
  plugins: [
    react({
      babel: {
        plugins: ['babel-plugin-macros'],
      },
    }),
  ],
  build: {
    rollupOptions: {
      input: {
        chat: 'index.html',
        history: 'history.html',
        project: 'project.html',
        settings: 'settings.html',
      },
    },
  },
});
