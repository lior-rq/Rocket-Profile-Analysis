import { useMemo, useRef, useState, type ReactNode } from "react";
import { flexRender, getCoreRowModel, getSortedRowModel, useReactTable, type ColumnDef, type SortingState } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { fmt, isNum } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";

export type Fmt = Record<string, (v: any, row: any) => ReactNode>;
export function DataTable({ columns, rows, labels = {}, format = {}, hide = [], onRow, rowKey, selected, sort, rowClass, cellClass, maxHeight = 420, tools, wrap = [] }: {
  columns: string[]; rows: any[]; labels?: Record<string, string>; format?: Fmt; hide?: string[]; onRow?: (r: any) => void; rowKey?: (r: any) => string; selected?: string | null;
  sort?: { key: string; dir?: 1 | -1 }; rowClass?: (r: any) => string; cellClass?: (c: string, v: any, r: any) => string; maxHeight?: number; tools?: { chooser?: string; csv?: string; hiddenDefault?: string[]; extra?: ReactNode; count?: boolean }; wrap?: string[];
}) {
  const storeKey = tools?.chooser ? "rpa-cols:" + tools.chooser : null;
  const [hidden, setHidden] = useState<Set<string>>(() => {
    const s = new Set(hide);
    if (storeKey) { let stored: string[] | null = null; try { stored = JSON.parse(localStorage.getItem(storeKey) || "null"); } catch { /* ignore */ } for (const c of Array.isArray(stored) ? stored : tools?.hiddenDefault || []) s.add(c); }
    return s;
  });
  const [sorting, setSorting] = useState<SortingState>(sort ? [{ id: sort.key, desc: (sort.dir || 1) < 0 }] : []);
  const numCols = useMemo(() => new Set(columns.filter((c) => rows.some((r) => isNum(r[c])))), [columns, rows]);
  const cols = useMemo<ColumnDef<any>[]>(() => columns.filter((c) => !hidden.has(c)).map((c) => ({
    id: c, accessorFn: (r) => r[c], header: labels[c] || c,
    cell: (info) => { const v = info.getValue(); const r = info.row.original; return format[c] ? format[c](v, r) : fmt(v); },
    sortingFn: (a, b) => { const x = a.getValue(c) as any, y = b.getValue(c) as any; if (x == null) return 1; if (y == null) return -1; return isNum(x) && isNum(y) ? x - y : String(x).localeCompare(String(y)); },
  })), [columns, hidden, labels, format]);
  const table = useReactTable({ data: rows, columns: cols, state: { sorting }, onSortingChange: setSorting, getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel() });
  const parentRef = useRef<HTMLDivElement>(null);
  const vrows = table.getRowModel().rows;
  const virt = useVirtualizer({ count: vrows.length, getScrollElement: () => parentRef.current, estimateSize: () => 30, overscan: 12 });
  const items = virt.getVirtualItems();
  const padTop = items.length ? items[0].start : 0, padBot = items.length ? virt.getTotalSize() - items[items.length - 1].end : 0;
  const csv = () => {
    const cs = columns.filter((c) => !hidden.has(c) && c !== "star");
    const q = (v: any) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const text = [cs.map((c) => q(labels[c] || c)).join(",")].concat(vrows.map((r) => cs.map((c) => q(r.original[c])).join(","))).join("\n");
    const url = URL.createObjectURL(new Blob([text], { type: "text/csv" })); const a = document.createElement("a"); a.href = url; a.download = tools?.csv || "table.csv"; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <div>
    {tools ? <div className="mb-1 flex flex-wrap items-center gap-2 text-[12px] text-muted">{tools.count !== false ? <span>{rows.length} row{rows.length === 1 ? "" : "s"}</span> : null}
      {tools.chooser ? <details className="relative"><summary className="cursor-pointer rounded border border-line px-2 py-0.5">columns ▾</summary><div className="absolute z-20 mt-1 max-h-[300px] w-[240px] overflow-auto rounded border border-line bg-panel p-2 shadow-lg">{columns.filter((c) => !hide.includes(c)).map((c) => <label key={c} className="flex items-center gap-1.5 py-0.5"><input type="checkbox" checked={!hidden.has(c)} onChange={(e) => { const n = new Set(hidden); if (e.target.checked) n.delete(c); else n.add(c); setHidden(n); if (storeKey) try { localStorage.setItem(storeKey, JSON.stringify([...n])); } catch { /* ignore */ } }} />{labels[c] || c}</label>)}</div></details> : null}
      {tools.csv ? <Button size="sm" onClick={csv}>Export CSV</Button> : null}{tools.extra}</div> : null}
    <div ref={parentRef} className="overflow-auto rounded border border-line" style={{ maxHeight }}>
      <table className="w-full border-collapse text-[12.5px]">
        <thead className="sticky top-0 z-10 bg-panel-2">{table.getHeaderGroups().map((hg) => <tr key={hg.id}>{hg.headers.map((h) => { const c = h.column.id; const s = h.column.getIsSorted(); return <th key={h.id} className={cn("border-b border-line px-2 py-1.5 text-left font-semibold whitespace-nowrap", numCols.has(c) && "text-right", c === "booster" && "sticky left-0 bg-panel-2")} aria-sort={s ? (s === "asc" ? "ascending" : "descending") : "none"}><button type="button" className="hover:text-accent" onClick={h.column.getToggleSortingHandler()}>{flexRender(h.column.columnDef.header, h.getContext())}{s ? (s === "asc" ? " ▲" : " ▼") : ""}</button></th>; })}</tr>)}</thead>
        <tbody>
          {padTop > 0 ? <tr><td style={{ height: padTop }} colSpan={cols.length} /></tr> : null}
          {items.map((vi) => { const row = vrows[vi.index]; const r = row.original; const key = rowKey ? rowKey(r) : String(vi.index); const sel = selected != null && key === selected; return <tr key={row.id} data-index={vi.index} ref={virt.measureElement} className={cn("border-b border-line", onRow && "cursor-pointer hover:bg-panel-2", sel && "bg-accent-bg/60", rowClass?.(r))} tabIndex={onRow ? 0 : undefined} onClick={onRow ? () => onRow(r) : undefined} onKeyDown={onRow ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onRow(r); } } : undefined}>
            {row.getVisibleCells().map((cell) => { const c = cell.column.id; return <td key={cell.id} className={cn("px-2 py-1 whitespace-nowrap", numCols.has(c) && "text-right font-mono", wrap.includes(c) && "whitespace-normal", c === "booster" && "sticky left-0 bg-panel", cellClass?.(c, r[c], r))}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>; })}
          </tr>; })}
          {padBot > 0 ? <tr><td style={{ height: padBot }} colSpan={cols.length} /></tr> : null}
        </tbody>
      </table>
    </div>
  </div>;
}
