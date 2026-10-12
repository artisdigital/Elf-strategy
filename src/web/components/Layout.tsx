import { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useStore } from '../lib/store';
import { Badge } from './ui';
import { Icon } from './icons';
import { InstallPrompt } from './InstallPrompt';

export const NAV = [
  { to: '/', label: 'Dashboard', icon: 'dashboard' },
  { to: '/chart', label: 'Live Charts', icon: 'chart' },
  { to: '/strategy', label: 'ELF Strategy', icon: 'strategy' },
  { to: '/planner', label: 'Trade Planner', icon: 'planner' },
  { to: '/alerts', label: 'Alerts', icon: 'alerts' },
  { to: '/journal', label: 'Trade Journal', icon: 'journal' },
  { to: '/replay', label: 'Replay', icon: 'replay' },
  { to: '/backtest', label: 'Backtesting', icon: 'backtest' },
  { to: '/providers', label: 'Market Data', icon: 'providers' },
  { to: '/settings', label: 'Settings & Rules', icon: 'settings' },
];

const MOBILE_TABS = ['/', '/chart', '/alerts', '/journal'];

export function Layout() {
  const { unread, toasts, dismissToast } = useStore();
  const [more, setMore] = useState(false);
  const loc = useLocation();
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="logo">◆</span>
          <div>
            <div className="brand-t">ELF</div>
            <div className="brand-s">Emerald Liquidity Flow</div>
          </div>
        </div>
        <nav>
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => `nav-i ${isActive ? 'on' : ''}`}>
              <span className="nav-ic"><Icon name={n.icon} /></span>
              <span>{n.label}</span>
              {n.to === '/alerts' && unread > 0 && <Badge tone="accent">{unread}</Badge>}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">Decision support only. No orders are placed. Not financial advice.</div>
      </aside>
      <main className="main" key={loc.pathname}>
        <InstallPrompt />
        <Outlet />
      </main>
      <nav className="tabbar">
        {NAV.filter((n) => MOBILE_TABS.includes(n.to)).map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => `tab ${isActive ? 'on' : ''}`} onClick={() => setMore(false)}>
            <span className="tab-ic"><Icon name={n.icon} size={20} /></span>
            <span className="tab-l">{n.label.replace('Live ', '').replace('Trade ', '')}</span>
            {n.to === '/alerts' && unread > 0 && <span className="tab-dot">{unread > 99 ? '99+' : unread}</span>}
          </NavLink>
        ))}
        <button className={`tab ${more ? 'on' : ''}`} onClick={() => setMore((v) => !v)} aria-expanded={more}>
          <span className="tab-ic"><Icon name="more" size={20} /></span>
          <span className="tab-l">More</span>
        </button>
      </nav>
      {more && (
        <div className="sheet-bg" onClick={() => setMore(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            {NAV.filter((n) => !MOBILE_TABS.includes(n.to)).map((n) => (
              <NavLink key={n.to} to={n.to} className="sheet-i" onClick={() => setMore(false)}>
                <span className="nav-ic"><Icon name={n.icon} /></span> {n.label}
              </NavLink>
            ))}
          </div>
        </div>
      )}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`} onClick={() => dismissToast(t.id)}>
            <strong>{t.title}</strong>
            <div>{t.message}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function PageHeader({ title, sub, right }: { title: string; sub?: React.ReactNode; right?: React.ReactNode }) {
  return (
    <header className="page-h">
      <div>
        <h1>{title}</h1>
        {sub && <p className="muted">{sub}</p>}
      </div>
      {right && <div className="page-h-r">{right}</div>}
    </header>
  );
}
