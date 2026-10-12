import { formatNy } from '../../shared/time';

export const fmtPrice = (n: number | null | undefined) => {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  return n.toLocaleString('en-US', { minimumFractionDigits: a >= 1000 ? 2 : a >= 10 ? 3 : a >= 1 ? 4 : 5, maximumFractionDigits: a >= 1000 ? 2 : a >= 10 ? 3 : a >= 1 ? 4 : 5 });
};
export const fmtR = (n: number | null | undefined, digits = 2) => (n === null || n === undefined || !Number.isFinite(n) ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(digits)}R`);
export const fmtPct = (n: number | null | undefined, digits = 1) => (n === null || n === undefined || !Number.isFinite(n) ? '—' : `${(n * 100).toFixed(digits)}%`);
export const fmtNum = (n: number | null | undefined, digits = 2) => (n === null || n === undefined || !Number.isFinite(n) ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: digits }));
export const fmtTime = (s: number | null | undefined) => (s ? formatNy(s) : '—');
export const fmtRel = (ms: number | null | undefined) => {
  if (!ms) return '—';
  const d = Math.round((Date.now() - ms) / 1000);
  if (d < 5) return 'just now';
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  return `${Math.floor(d / 3600)}h ago`;
};
export const toDateInput = (s: number) => new Date(s * 1000).toISOString().slice(0, 10);
export const fromDateInput = (v: string, endOfDay = false) => Math.floor(Date.parse(v + (endOfDay ? 'T23:59:59Z' : 'T00:00:00Z')) / 1000);

export function download(filename: string, content: string, type = 'text/plain') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
