/**
 * Root config delegates to the per-target configs:
 *  - vite.sidebar.config.ts    (dev server + sidebar build)
 *  - vite.background.config.ts (background IIFE)
 *  - vite.content.config.ts    (content IIFE)
 *
 * Run `npm run build` (scripts/build.mjs) for the full production build.
 */
export { default } from "./vite.sidebar.config";
