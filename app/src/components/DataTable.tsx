/* A sortable, virtualised table with a column chooser and CSV export. */
import { useMemo, useRef, useState, type ReactNode } from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { flexRender, getCoreRowModel, getSortedRowModel, useReactTable, type ColumnDef, type SortingState } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, Check, ChevronsUpDown, Columns3, Download } from "lucide-react";
import { fmt, isNum } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useUi } from "@/store/ui";
import { Button, Icon, Skeleton } from "./ui";

export type Fmt = Record<string, (v: any, row: any) => ReactNode>;

export function DataTable({ columns, rows, labels = {}, format = {}, hide = [], onRow, rowKey, selected, sort, rowClass, cellClass, maxHeight = 420, tools, wrap = [], sticky, loading }: {
  columns: string[]; rows: any[]; labels?: Record<string, string>; format?: Fmt; hide?: string[]; onRow?: (r: any) => void; rowKey?: (r: any) => string; selected?: string | null;
  sort?: { key: string; dir?: 1 | -1 }; rowClass?: (r: any) => string; cellClass?: (c: string, v: any, r: any) => string; maxHeight?: number;
  tools?: { chooser?: string; csv?: string; hiddenDefault?: string[]; extra?: ReactNode; count?: boolean }; wrap?: string[];
  /** Column kept visible while scrolling sideways. */
  sticky?: string; loading?: boolean;
}) {
  const storeKey = tools?.chooser || null;
  const stored = useUi((s) => (storeKey ? s.hiddenCols[storeKey] : undefined));
  const setHiddenCols = useUi((s) => s.setHiddenCols);
  const [local, setLocal] = useState<string[] | null>(null);
  const hidden = useMemo(() => new Set([...hide, ...(local ?? stored ?? tools?.hiddenDefault ?? [])]), [hide, local, stored, tools?.hiddenDefault]);
  const setHidden = (next: Set<string>) => { const arr = [...next].filter((c) => !hide.includes(c)); setLocal(arr); if (storeKey) setHiddenCols(storeKey, arr); };
  const [sorting, setSorting] = useState<SortingState>(sort ? [{ id: sort.key, desc: (sort.dir || 1) < 0 }] : []);
  const numCols = useMemo(() => new Set(columns.filter((c) => rows.some((r) => isNum(r[c])))), [columns, rows]);
  const cols = useMemo<ColumnDef<any>[]>(() => columns.filter((c) => !hidden.has(c)).map((c) => ({
    id: c, accessorFn: (r) => r[c], header: labels[c] ?? c,
    cell: (info) => { const val = info.getValue(); const r = info.row.original; return format[c] ? format[c](val, r) : fmt(val); },
    sortingFn: (a, b) => { const x = a.getValue(c) as any, y = b.getValue(c) as any; if (x == null) return 1; if (y == null) return -1; return isNum(x) && isNum(y) ? x - y : String(x).localeCompare(String(y)); },
  })), [columns, hidden, labels, format]);
  const table = useReactTable({ data: rows, columns: cols, state: { sorting }, onSortingChange: setSorting, getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel() });
  const parentRef = useRef<HTMLDivElement>(null);
  const vrows = table.getRowModel().rows;
  const virt = useVirtualizer({ count: vrows.length, getScrollElement: () => parentRef.current, estimateSize: () => 31, overscan: 12 });
  const items = virt.getVirtualItems();
  const padTop = items.length ? items[0].start : 0, padBot = items.length ? virt.getTotalSize() - items[items.length - 1].end : 0;
  const csv = () => {
    const cs = columns.filter((c) => !hidden.has(c) && c !== "star");
    const q = (val: any) => { const s = val == null ? "" : String(val); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const text = [cs.map((c) => q(labels[c] || c)).join(",")].concat(vrows.map((r) => cs.map((c) => q(r.original[c])).join(","))).join("\n");
    const url = URL.createObjectURL(new Blob([text], { type: "text/csv" })); const a = document.createElement("a"); a.href = url; a.download = tools?.csv || "table.csv"; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  if (loading) return <div className="flex flex-col gap-2"><Skeleton height={28} />{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} height={26} />)}</div>;
  return (
    <div className="flex flex-col gap-1.5 min-w-0">
      {tools ? (
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-3">
          {tools.count !== false ? <span className="num">{rows.length} row{rows.length === 1 ? "" : "s"}</span> : null}
          {tools.chooser ? (
            <Menu.Root>
              <Menu.Trigger asChild><Button variant="chip" size="sm"><Icon of={Columns3} size="xs" />columns</Button></Menu.Trigger>
              <Menu.Portal>
                <Menu.Content className="menu glass-strong" sideOffset={6} align="start">
                  <div className="menu-label">Columns</div>
                  {columns.filter((c) => !hide.includes(c)).map((c) => (
                    <Menu.CheckboxItem key={c} className="menu-item" checked={!hidden.has(c)} onSelect={(e) => e.preventDefault()}
                                       onCheckedChange={(on) => { const n = new Set(hidden); if (on) n.delete(c); else n.add(c); setHidden(n); }}>
                      <span className="menu-check"><Menu.ItemIndicator><Icon of={Check} size="sm" /></Menu.ItemIndicator></span>{labels[c] || c}
                    </Menu.CheckboxItem>
                  ))}
                </Menu.Content>
              </Menu.Portal>
            </Menu.Root>
          ) : null}
          {tools.csv ? <Button variant="chip" size="sm" onClick={csv}><Icon of={Download} size="xs" />CSV</Button> : null}
          {tools.extra}
        </div>
      ) : null}
      <div ref={parentRef} className="table-wrap" style={{ maxHeight }}>
        <table className="data-table">
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => {
                  const c = h.column.id; const s = h.column.getIsSorted();
                  return (
                    <th key={h.id} className={cn("sortable", numCols.has(c) && "n", s && "on", c === sticky && "sticky")} aria-sort={s ? (s === "asc" ? "ascending" : "descending") : "none"}
                        onClick={h.column.getToggleSortingHandler()}>
                      <span className="th-inner">{flexRender(h.column.columnDef.header, h.getContext())}<Icon of={s === "asc" ? ArrowUp : s === "desc" ? ArrowDown : ChevronsUpDown} size="xs" className={cn(!s && "opacity-40")} /></span>
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {padTop > 0 ? <tr><td style={{ height: padTop, padding: 0, border: 0 }} colSpan={cols.length} /></tr> : null}
            {items.map((vi) => {
              const row = vrows[vi.index]; const r = row.original; const key = rowKey ? rowKey(r) : String(vi.index); const sel = selected != null && key === selected;
              return (
                <tr key={row.id} data-index={vi.index} ref={virt.measureElement} className={cn(onRow && "clickable", sel && "pick", rowClass?.(r))} tabIndex={onRow ? 0 : undefined}
                    onClick={onRow ? () => onRow(r) : undefined} onKeyDown={onRow ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onRow(r); } } : undefined}>
                  {row.getVisibleCells().map((cell) => { const c = cell.column.id; return <td key={cell.id} className={cn(numCols.has(c) && "n", wrap.includes(c) && "wrap", c === sticky && "sticky", cellClass?.(c, r[c], r))}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>; })}
                </tr>
              );
            })}
            {padBot > 0 ? <tr><td style={{ height: padBot, padding: 0, border: 0 }} colSpan={cols.length} /></tr> : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
