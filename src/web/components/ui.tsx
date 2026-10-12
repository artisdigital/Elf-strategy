import React, { useEffect } from 'react';
import type { FeedState } from '../../shared/types';
import type { ElfState } from '../../engine/engine';
import { fmtRel } from '../lib/format';

export function Card({ title, right, children, className = '' }: { title?: React.ReactNode; right?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || right) && (
        <header className="card-h">
          <h3>{title}</h3>
          {right}
        </header>
      )}
      {children}
    </section>
  );
}

export function Badge({ children, tone = 'neutral', title }: { children: React.ReactNode; tone?: 'neutral' | 'good' | 'bad' | 'warn' | 'info' | 'accent'; title?: string }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

const FEED_TONE: Record<string, 'good' | 'info' | 'warn' | 'bad' | 'neutral'> = {
  LIVE: 'good',
  'REST POLLING': 'info',
  DELAYED: 'warn',
  DISCONNECTED: 'bad',
  'NEEDS KEY': 'warn',
  ERROR: 'bad',
  CONNECTING: 'neutral',
};

export function FeedBadge({ feed, compact = false }: { feed: FeedState | null; compact?: boolean }) {
  if (!feed) return <Badge>CONNECTING</Badge>;
  return (
    <span className="feed-badge" title={feed.message}>
      <Badge tone={FEED_TONE[feed.status] ?? 'neutral'}>
        <span className={`dot dot-${FEED_TONE[feed.status]}`} /> {feed.status}
      </Badge>
      {!compact && <small className="muted"> {feed.message} · {fmtRel(feed.lastUpdate)}</small>}
    </span>
  );
}

const STATE_TONE: Record<ElfState, 'neutral' | 'info' | 'warn' | 'accent' | 'good' | 'bad'> = {
  IDLE: 'neutral',
  BUILD: 'neutral',
  SWEPT: 'warn',
  CONFIRMED: 'info',
  ENTRY_READY: 'accent',
  MANAGING: 'info',
  COMPLETED: 'neutral',
  FILTERED: 'bad',
};

export function StateBadge({ state }: { state: ElfState | undefined }) {
  if (!state) return <Badge>—</Badge>;
  return <Badge tone={STATE_TONE[state]}>{state.replace('_', ' ')}</Badge>;
}

export function Stat({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: 'pos' | 'neg' | '' }) {
  return (
    <div className="stat">
      <div className="stat-l">{label}</div>
      <div className={`stat-v ${tone ?? ''}`}>{value}</div>
      {sub && <div className="stat-s">{sub}</div>}
    </div>
  );
}

export function KV({ k, v, title }: { k: React.ReactNode; v: React.ReactNode; title?: string }) {
  return (
    <div className="kv" title={title}>
      <span className="k">{k}</span>
      <span className="v">{v}</span>
    </div>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: React.ReactNode; disabled?: boolean }) {
  return (
    <label className={`toggle ${disabled ? 'disabled' : ''}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="track">
        <span className="thumb" />
      </span>
      {label && <span className="toggle-l">{label}</span>}
    </label>
  );
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'bad' | 'good'; children: React.ReactNode }) {
  return <div className={`notice notice-${tone}`}>{children}</div>;
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <header className="card-h">
          <h3>{title}</h3>
          <button className="btn btn-ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function Field({ label, children, hint, error }: { label: React.ReactNode; children: React.ReactNode; hint?: React.ReactNode; error?: string | null }) {
  return (
    <label className="field">
      <span className="field-l">{label}</span>
      {children}
      {hint && <span className="field-h">{hint}</span>}
      {error && <span className="field-e">{error}</span>}
    </label>
  );
}

export function Table({ children }: { children: React.ReactNode }) {
  return (
    <div className="table-wrap">
      <table>{children}</table>
    </div>
  );
}

export function SampleWarning({ text }: { text: string | null | undefined }) {
  if (!text) return null;
  return <Notice tone="warn">⚠ {text}</Notice>;
}
