// lightweight-charts series primitive that draws ELF boxes, level segments and labels.
// Times are mapped to bar indices (nearest bar at or before the time) so drawings stay
// aligned to real candles even when a timestamp falls inside a data gap.

import type { ISeriesPrimitive, SeriesAttachedParameter, Time, ISeriesPrimitivePaneView, ISeriesPrimitivePaneRenderer, Logical, IChartApi, ISeriesApi, SeriesType } from 'lightweight-charts';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import type { Box, Segment } from './overlays';

export class ElfOverlayPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private series: ISeriesApi<SeriesType> | null = null;
  private requestUpdate: (() => void) | null = null;
  private boxes: Box[] = [];
  private segments: Segment[] = [];
  private times: number[] = [];
  private readonly view: ISeriesPrimitivePaneView;
  private readonly bgView: ISeriesPrimitivePaneView;

  constructor() {
    const self = this;
    const renderer: ISeriesPrimitivePaneRenderer = { draw: (t) => self.drawFg(t) };
    const bgRenderer: ISeriesPrimitivePaneRenderer = { draw: () => {}, drawBackground: (t) => self.drawBg(t) };
    this.view = { renderer: () => renderer, zOrder: () => 'top' };
    this.bgView = { renderer: () => bgRenderer, zOrder: () => 'bottom' };
  }

  attached(p: SeriesAttachedParameter<Time>) {
    this.chart = p.chart as IChartApi;
    this.series = p.series as ISeriesApi<SeriesType>;
    this.requestUpdate = p.requestUpdate;
  }

  detached() {
    this.chart = this.series = null;
    this.requestUpdate = null;
  }

  paneViews() {
    return [this.bgView, this.view];
  }

  setData(times: number[], boxes: Box[], segments: Segment[]) {
    this.times = times;
    this.boxes = boxes;
    this.segments = segments;
    this.requestUpdate?.();
  }

  private x(time: number): number | null {
    if (!this.chart || this.times.length === 0) return null;
    const ts = this.times;
    let lo = 0;
    let hi = ts.length - 1;
    let idx = 0;
    if (time <= ts[0]) idx = 0;
    else if (time >= ts[hi]) idx = hi;
    else {
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (ts[mid] <= time) {
          idx = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
    }
    return this.chart.timeScale().logicalToCoordinate(idx as Logical);
  }

  private y(price: number): number | null {
    return this.series?.priceToCoordinate(price) ?? null;
  }

  private drawBg(target: CanvasRenderingTarget2D) {
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const half = this.barHalf();
      for (const b of this.boxes) {
        const x1 = this.x(b.t1);
        const x2 = this.x(b.t2);
        const y1 = this.y(b.p1);
        const y2 = this.y(b.p2);
        if (x1 === null || x2 === null || y1 === null || y2 === null) continue;
        const left = Math.min(x1, x2) - half;
        const right = Math.max(x1, x2) + half;
        if (right < 0 || left > mediaSize.width) continue;
        const top = Math.min(y1, y2);
        const h = Math.max(1, Math.abs(y2 - y1));
        ctx.fillStyle = b.fill;
        ctx.fillRect(left, top, right - left, h);
        if (b.stroke) {
          ctx.strokeStyle = b.stroke;
          ctx.lineWidth = 1;
          ctx.setLineDash(b.dashed ? [4, 3] : []);
          ctx.strokeRect(left + 0.5, top + 0.5, right - left - 1, h - 1);
        }
        if (b.midLine) {
          ctx.strokeStyle = b.stroke ?? '#ffffff55';
          ctx.setLineDash([2, 3]);
          ctx.beginPath();
          ctx.moveTo(left, top + h / 2);
          ctx.lineTo(right, top + h / 2);
          ctx.stroke();
        }
        ctx.setLineDash([]);
      }
    });
  }

  private barHalf() {
    if (!this.chart || this.times.length < 2) return 3;
    const a = this.chart.timeScale().logicalToCoordinate(0 as Logical);
    const b = this.chart.timeScale().logicalToCoordinate(1 as Logical);
    return a !== null && b !== null ? Math.abs(b - a) / 2 : 3;
  }

  private drawFg(target: CanvasRenderingTarget2D) {
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      ctx.font = '10px ui-sans-serif, system-ui, -apple-system, sans-serif';
      ctx.textBaseline = 'middle';
      const labelBoxes: { x: number; y: number; w: number }[] = [];
      for (const s of this.segments) {
        const x1 = this.x(s.t1);
        const x2raw = this.x(s.t2);
        const y = this.y(s.price);
        if (x1 === null || x2raw === null || y === null) continue;
        const x2 = s.extendRight ? mediaSize.width : x2raw;
        if (x2 < 0 || x1 > mediaSize.width || y < -20 || y > mediaSize.height + 20) continue;
        ctx.strokeStyle = s.color;
        ctx.lineWidth = s.width ?? 1;
        ctx.setLineDash(s.dashed ? [5, 4] : []);
        ctx.beginPath();
        ctx.moveTo(Math.max(0, x1), y);
        ctx.lineTo(x2, y);
        ctx.stroke();
        ctx.setLineDash([]);
        if (s.label) {
          const w = ctx.measureText(s.label).width + 6;
          let lx = s.labelSide === 'left' ? Math.max(2, x1) : Math.min(x2, mediaSize.width) - w - 4;
          if (s.extendRight) lx = Math.min(Math.max(2, x2raw + 8), mediaSize.width - w - 4);
          let ly = y - 7;
          // avoid stacking labels on top of each other
          for (const lb of labelBoxes) if (Math.abs(lb.y - ly) < 12 && Math.abs(lb.x - lx) < Math.max(lb.w, w)) ly = lb.y - 12;
          labelBoxes.push({ x: lx, y: ly, w });
          ctx.fillStyle = 'rgba(11,15,20,0.78)';
          ctx.fillRect(lx, ly - 6, w, 12);
          ctx.fillStyle = s.color.length > 7 ? s.color.slice(0, 7) : s.color;
          ctx.fillText(s.label, lx + 3, ly);
        }
      }
      for (const b of this.boxes) {
        if (!b.label) continue;
        const x1 = this.x(b.t1);
        const y1 = this.y(Math.max(b.p1, b.p2));
        if (x1 === null || y1 === null || x1 > mediaSize.width) continue;
        ctx.fillStyle = b.labelColor ?? '#cbd5e1';
        ctx.fillText(b.label, Math.max(2, x1 - this.barHalf() + 2), y1 - 7);
      }
    });
  }
}
