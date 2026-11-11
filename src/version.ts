/** App version injected from package.json by vite.config.ts (VITE_APP_VERSION).
 *  Single source for the viewer title bar, status bar and postMessage `ready`. */
export const VIEWER_VERSION: string = (import.meta as any).env?.VITE_APP_VERSION ?? '0.0.0';
