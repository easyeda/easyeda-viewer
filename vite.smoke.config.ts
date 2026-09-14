// Vite config for the headless smoke test: swap leafer-ui's web bundle
// (needs DOM) for the DOM-free @leafer-ui/draw package.
import { defineConfig } from 'vite';

export default defineConfig({
  resolve: { alias: { 'leafer-ui': '@leafer-ui/draw' } },
});
