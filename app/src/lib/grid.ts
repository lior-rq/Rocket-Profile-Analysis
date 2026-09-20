/* The delay grids the search flies (rpa/search.py); separation: max 9 pts. */
export function sepGridPoints(lo: number, hi: number, step: number, maxPoints = 9): number[] {
  lo = +lo; hi = +hi; step = +step;
  if (!(hi - lo > 1e-9)) return [+lo.toFixed(2)];
  const st = Math.max(step, (hi - lo) / (maxPoints - 1));
  const n = Math.floor((hi - lo) / st + 1e-9) + 1;
  const pts = new Set<number>();
  for (let i = 0; i < n; i++) pts.add(+(lo + i * st).toFixed(2));
  pts.add(+hi.toFixed(2));
  return [...pts].sort((a, b) => a - b);
}
export function ignGridPoints(lo: number, hi: number, step: number): number[] {
  lo = +lo; hi = +hi; step = +step;
  if (lo > hi || !(step > 0)) return [+lo.toFixed(2)];
  const n = Math.floor((hi - lo) / step + 1e-9) + 1;
  const ds: number[] = [];
  for (let i = 0; i < n; i++) ds.push(+(lo + i * step).toFixed(2));
  if (ds[ds.length - 1] < hi - 1e-6) ds.push(+hi.toFixed(2));
  return ds;
}
export function gridSummary(p: Record<string, number>) {
  const sep = sepGridPoints(p.separation_delay_min_s, p.separation_delay_max_s, p.separation_step_s);
  const ign = ignGridPoints(p.ignition_delay_min_s, p.ignition_delay_max_s, p.coarse_step_s);
  const sepStep = sep.length > 1 ? sep[1] - sep[0] : 0;
  return { sep, ign, sepStep, capped: sep.length > 1 && sepStep > +p.separation_step_s + 1e-9 };
}
