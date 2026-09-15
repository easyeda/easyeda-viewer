import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default defineConfig({
  base: './',
  define: { 'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version) },
  // headless smoke tests import the DOM-free draw build instead of the web bundle
  resolve: process.env.EV_HEADLESS ? { alias: { 'leafer-ui': '@leafer-ui/draw' } } : {},
  plugins: [viteSingleFile()],
  build: {
    target: 'es2021',
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
  },
  test: {
    include: ['test/**/*.spec.ts'],
  },
} as any);
