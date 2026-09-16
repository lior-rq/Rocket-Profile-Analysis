/* HTTP + SSE client for the rpa service. In the browser the UI is served by
   the service (relative URLs). Inside the Tauri shell the page is also loaded
   from the service, so the same relative URLs work. */
export const BASE = ((globalThis as any).__RPA_BASE__ as string) || "";

export class ApiError extends Error {
  status: number;
  constructor(msg: string, status: number) { super(msg); this.status = status; }
}

export async function api<T = any>(path: string, body?: unknown, init?: RequestInit): Promise<T> {
  const r = await fetch(BASE + path, body !== undefined ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), ...init } : init);
  let data: any = null;
  try { data = await r.json(); } catch { data = { error: `bad response (${r.status})` }; }
  if (!r.ok || (data && data.error)) throw new ApiError((data && data.error) || `HTTP ${r.status}`, r.status);
  return data as T;
}

export async function downloadFile(url: string): Promise<string | null> {
  const r = await fetch(BASE + url);
  if (!r.ok) { let data: any = null; try { data = await r.json(); } catch { /* not json */ } throw new ApiError((data && data.error) || `HTTP ${r.status}`, r.status); }
  const m = /filename="([^"]+)"/.exec(r.headers.get("Content-Disposition") || "");
  const href = URL.createObjectURL(await r.blob());
  const a = document.createElement("a");
  a.href = href; a.download = m ? m[1] : "download";
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
  return m ? m[1] : null;
}

export const fileUrl = (rel: string, mtime?: number | null) => `${BASE}/files/${rel}${mtime ? "?t=" + mtime : ""}`;

export type RunnerStatus = {
  running: boolean; stage: string | null; args: string[]; label?: string; started: number | null; finished: number | null; exit_code: number | null;
  substage: string | null; progress: { done: number; total: number } | null; round: { round: string; rows: number } | null; elapsed_s: number;
  cancelled: boolean; error_lines: number; last_error: string | null; log: string | null; side: { stage: string; args: string[]; label?: string; started: number; elapsed_s?: number; log?: string | null } | null;
};
export type LogLine = { seq: number; t: number; text: string };

/* Server-sent events with auto-reconnect. */
export function connectEvents(handlers: { log?: (rec: LogLine) => void; state?: (r: RunnerStatus) => void; changed?: () => void; open?: () => void; error?: () => void }) {
  let es: EventSource | null = null;
  let stopped = false;
  let timer: number | null = null;
  const open = () => {
    if (stopped) return;
    es = new EventSource(BASE + "/api/events");
    es.addEventListener("log", (ev) => handlers.log?.(JSON.parse((ev as MessageEvent).data)));
    es.addEventListener("state", (ev) => handlers.state?.(JSON.parse((ev as MessageEvent).data)));
    es.addEventListener("changed", () => handlers.changed?.());
    es.onopen = () => handlers.open?.();
    es.onerror = () => { handlers.error?.(); es?.close(); if (!stopped) timer = window.setTimeout(open, 3000); };
  };
  open();
  return () => { stopped = true; if (timer) clearTimeout(timer); es?.close(); };
}
