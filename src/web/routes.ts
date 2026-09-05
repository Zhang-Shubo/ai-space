import { join } from "node:path";
import index from "./index.html";

/**
 * Routes for the web UI: the bundled page at `/` (Bun's HTML import bundles
 * main.tsx and styles.css) and the few files the PWA shell and the pet need
 * at fixed public paths.
 */

const PUBLIC: Record<string, string> = {
  "/favicon.svg": "favicon.svg",
  "/settings.svg": "settings.svg",
  "/manifest.webmanifest": "manifest.webmanifest",
  "/apple-touch-icon.png": "apple-touch-icon.png",
  "/icon-512.png": "icon-512.png",
  "/pet.webp": "pet.webp",
};

type WebRoutes = Record<string, typeof index | (() => Response)>;

export function createWebRoutes(): WebRoutes {
  const routes: WebRoutes = { "/": index };
  for (const [path, file] of Object.entries(PUBLIC)) {
    routes[path] = () => new Response(Bun.file(join(import.meta.dir, "public", file)), { headers: { "cache-control": "public, max-age=86400" } });
  }
  return routes;
}
