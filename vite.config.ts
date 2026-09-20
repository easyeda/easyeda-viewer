import { defineConfig, type Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// favicon = the exe's own icon (#app-favicon): the desktop .ico inlined as a
// data URI so the single-file build (and the dev server) need no extra request
// and the browser tab always matches the installed app icon
const appIconFavicon = (): Plugin => ({
  name: 'app-icon-favicon',
  transformIndexHtml(html: string): string {
    const ico = readFileSync(new URL('./desktop/app.ico', import.meta.url));
    const link = `<link rel="icon" type="image/x-icon" href="data:image/x-icon;base64,${ico.toString('base64')}"/>`;
    return html.replace('</title>', `</title>\n    ${link}`);
  },
});

export default defineConfig({
  base: './',
  define: { 'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version) },
  // headless smoke tests import the DOM-free draw build instead of the web bundle
  resolve: process.env.EV_HEADLESS ? { alias: { 'leafer-ui': '@leafer-ui/draw' } } : {},
  plugins: [viteSingleFile(), appIconFavicon()],
  build: {
    target: 'es2021',
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
  },
  test: {
    include: ['test/**/*.spec.ts'],
  },
} as any);
