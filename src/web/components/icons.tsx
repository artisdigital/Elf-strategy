const P: Record<string, string> = {
  dashboard: 'M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z',
  chart: 'M3 3v18h18M7 15l4-4 3 3 5-6',
  strategy: 'M12 2l9 5-9 5-9-5 9-5zM3 12l9 5 9-5M3 17l9 5 9-5',
  planner: 'M12 5v14M5 12h14M4 4h16v16H4z',
  alerts: 'M6 8a6 6 0 1112 0c0 7 3 9 3 9H3s3-2 3-9M10 21h4',
  journal: 'M4 4h12l4 4v12H4zM8 10h8M8 14h8M8 18h5',
  replay: 'M5 4l12 8-12 8zM19 4v16',
  backtest: 'M12 8v4l3 2M4 12a8 8 0 108-8 8 8 0 00-7 4M4 4v4h4',
  providers: 'M4 7h13l-3-3M20 17H7l3 3',
  settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-2.7 1.1V21a2 2 0 11-4 0v-.1a1.6 1.6 0 00-2.7-1.1l-.1.1a2 2 0 11-2.8-2.8l.1-.1A1.6 1.6 0 003 15H3a2 2 0 110-4h.1a1.6 1.6 0 001.1-2.7l-.1-.1a2 2 0 112.8-2.8l.1.1A1.6 1.6 0 009 4.6V4.5a2 2 0 114 0v.1a1.6 1.6 0 002.7 1.1l.1-.1a2 2 0 112.8 2.8l-.1.1A1.6 1.6 0 0019.4 9H21a2 2 0 110 4h-.1a1.6 1.6 0 00-1.5 2z',
  more: 'M4 6h16M4 12h16M4 18h16',
};

export function Icon({ name, size = 18 }: { name: keyof typeof P | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={P[name] ?? P.more} />
    </svg>
  );
}
