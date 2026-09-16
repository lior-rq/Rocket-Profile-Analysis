/* Native file dialogs: the Tauri shell's when available, else the service's
   macOS dialog (/api/browse), else a typed path. */
import { api } from "./api";

const tauri = () => (globalThis as any).__TAURI_INTERNALS__ || (globalThis as any).__TAURI__;

export async function pickFile(prompt: string, ext?: string): Promise<string | null> {
  if (tauri()) {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const p = await open({ title: prompt, multiple: false, directory: false, filters: ext ? [{ name: ext, extensions: [ext.replace(/^\./, ""), ext.replace(/^\./, "").toLowerCase(), ext.replace(/^\./, "").toUpperCase()] }] : undefined });
      return typeof p === "string" ? await storePath(p) : null;
    } catch { /* fall through */ }
  }
  const r = await api("/api/browse", { kind: "file", prompt });
  if (r.cancelled) return null;
  if (r.error) throw new Error(r.error);
  return r.path;
}
export async function pickFolder(prompt: string): Promise<string | null> {
  if (tauri()) {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const p = await open({ title: prompt, directory: true, multiple: false });
      return typeof p === "string" ? await storePath(p) : null;
    } catch { /* fall through */ }
  }
  const r = await api("/api/browse", { kind: "folder", prompt });
  if (r.cancelled) return null;
  if (r.error) throw new Error(r.error);
  return r.path;
}
async function storePath(p: string): Promise<string> {
  try { const r = await api("/api/store_path", { path: p }); return r.path || p; } catch { return p; }
}
export const inTauri = () => !!tauri();
