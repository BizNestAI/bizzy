// File: /services/demo/loadDemoData.js
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

export async function loadDemoData() {
  // Prefer browser fetch when running client-side so Vite can serve the asset.
  if (typeof window !== 'undefined' && typeof fetch === 'function') {
    try {
      const res = await fetch('/services/demo/demoData.json', { cache: 'no-cache' });
      if (res.ok) return await res.json();
    } catch {
      // fall through to server-side path
    }
  }

  // Server-side fallback: read directly from file system using import.meta.url
  try {
    const baseDir =
      typeof import.meta !== 'undefined'
        ? path.dirname(fileURLToPath(import.meta.url))
        : path.resolve(process.cwd(), 'src/services/demo');
    const filePath = path.join(baseDir, 'demoData.json');
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.warn('[demo] loadDemoData failed:', err?.message || err);
    return null;
  }
}

export function isDemoMode() {
  const envFlag =
    (typeof import.meta !== "undefined" && import.meta?.env?.VITE_BIZZY_DEMO === "1") ||
    (typeof process !== "undefined" && process?.env?.VITE_BIZZY_DEMO === "1");
  if (envFlag) return true;

  const storage =
    typeof globalThis !== "undefined" && "localStorage" in globalThis
      ? globalThis.localStorage
      : null;
  if (!storage) return false;

  try {
    const flag = storage.getItem("bizzy:demo");
    return flag === "1" || flag === "true";
  } catch {
    return false;
  }
}
