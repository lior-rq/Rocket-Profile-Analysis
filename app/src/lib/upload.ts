/* Browser uploads into the project's input/<kind>/ folder (POST /api/upload):
   the file chooser, drag-and-drop of files or whole folders, and the copy. */
import { useCallback, useState, type DragEvent } from "react";
import { toast } from "sonner";
import { BASE } from "./api";

export type UploadKind = "boosters" | "sustainers" | "models";
export type Picked = { file: File; rel: string };  // rel keeps a dropped folder's structure

export const EXTS: Record<UploadKind, string[]> = { boosters: [".eng", ".ric"], sustainers: [".eng", ".ric"], models: [".ork", ".cdx1"] };
export const hasExt = (name: string, kind: UploadKind) => EXTS[kind].some((e) => name.toLowerCase().endsWith(e));

/* Dropped files and folders -> [{file, rel}]. */
export async function filesFromDrop(dt: DataTransfer): Promise<Picked[]> {
  const out: Picked[] = [];
  const walk = async (entry: any, prefix: string) => {
    if (entry.isFile) { const f: File = await new Promise((res, rej) => entry.file(res, rej)); out.push({ file: f, rel: prefix + f.name }); }
    else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch: any[];
      do { batch = await new Promise((res, rej) => reader.readEntries(res, rej)); for (const e of batch) await walk(e, prefix + entry.name + "/"); } while (batch.length);
    }
  };
  let viaEntries = false;
  for (const it of Array.from(dt.items || [])) { const e = (it as any).webkitGetAsEntry && (it as any).webkitGetAsEntry(); if (e) { viaEntries = true; await walk(e, ""); } }
  if (!viaEntries) for (const f of Array.from(dt.files)) out.push({ file: f, rel: f.name });
  return out;
}

/* The browser's file chooser -> [{file, rel}]. */
export function pickFiles({ multiple = false, folder = false, accept = "" } = {}): Promise<Picked[]> {
  return new Promise((resolve) => {
    const inp = document.createElement("input");
    inp.type = "file"; inp.style.display = "none";
    if (multiple) inp.multiple = true;
    if (folder) (inp as any).webkitdirectory = true;
    if (accept) inp.accept = accept;
    inp.onchange = () => { resolve(Array.from(inp.files || []).map((f) => ({ file: f, rel: (f as any).webkitRelativePath || f.name }))); inp.remove(); };
    inp.oncancel = () => { resolve([]); inp.remove(); };
    document.body.append(inp);
    inp.click();
  });
}

/* Copy files into input/<kind>/; returns the stored paths. */
export async function uploadFiles(kind: UploadKind, list: Picked[]): Promise<string[]> {
  const wanted = list.filter((x) => hasExt(x.rel, kind));
  if (!wanted.length) { if (list.length) toast.warning(`nothing to upload: no ${EXTS[kind].join(" / ")} files`); return []; }
  const skipped = list.length - wanted.length;
  const paths: string[] = [];
  let failed = 0;
  for (let i = 0; i < wanted.length; i += 4) {
    await Promise.all(wanted.slice(i, i + 4).map(async (x) => {
      try {
        const r = await fetch(`${BASE}/api/upload?kind=${kind}&name=${encodeURIComponent(x.rel)}`, { method: "POST", body: x.file });
        const d = await r.json();
        if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`);
        paths.push(d.path);
      } catch (e: any) { failed++; toast.error(`${x.rel}: ${e.message}`); }
    }));
  }
  if (paths.length) (failed ? toast.warning : toast.success)(`uploaded ${paths.length} file${paths.length === 1 ? "" : "s"} into input/${kind}/${skipped ? ` (${skipped} skipped: wrong type)` : ""}${failed ? `, ${failed} failed` : ""} — press Save`);
  return paths;
}

/* Drag-and-drop handlers + an "over" flag for any element. */
export function useDropZone(onFiles: (list: Picked[]) => void) {
  const [over, setOver] = useState(false);
  const [depth, setDepth] = useState(0);
  const onDragEnter = useCallback((e: DragEvent) => { e.preventDefault(); setDepth((d) => d + 1); setOver(true); }, []);
  const onDragOver = useCallback((e: DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }, []);
  const onDragLeave = useCallback(() => { setDepth((d) => { if (d - 1 <= 0) setOver(false); return Math.max(0, d - 1); }); }, []);
  const onDrop = useCallback(async (e: DragEvent) => { e.preventDefault(); setDepth(0); setOver(false); onFiles(await filesFromDrop(e.dataTransfer)); }, [onFiles]);
  void depth;
  return { over, handlers: { onDragEnter, onDragOver, onDragLeave, onDrop } };
}
