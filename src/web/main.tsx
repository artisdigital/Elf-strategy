import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import './styles.css';
import { StoreProvider, useStore } from './lib/store';
import { api } from './lib/api';
import { Layout } from './components/Layout';
import { Dashboard } from './pages/Dashboard';
import { LiveChart } from './pages/LiveChart';
import { Strategy } from './pages/Strategy';
import { Planner } from './pages/Planner';
import { Alerts } from './pages/Alerts';
import { Journal } from './pages/Journal';
import { Replay } from './pages/Replay';
import { Backtest } from './pages/Backtest';
import { Providers } from './pages/Providers';
import { Settings } from './pages/Settings';

function Login() {
  const { refresh } = useStore();
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  return (
    <div className="login">
      <form
        className="card"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api.post('/api/auth/login', { password: pw });
            await refresh();
          } catch (ex: any) {
            setErr(ex.message);
          }
        }}
      >
        <h1>◆ ELF</h1>
        <p className="muted">Emerald Liquidity Flow</p>
        <input type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Password" />
        {err && <p className="neg">{err}</p>}
        <button className="btn btn-primary">Sign in</button>
      </form>
    </div>
  );
}

function Shell() {
  const { ready, authRequired } = useStore();
  if (!ready) return <div className="splash">Loading ELF…</div>;
  if (authRequired) return <Login />;
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="chart" element={<LiveChart />} />
        <Route path="strategy" element={<Strategy />} />
        <Route path="planner" element={<Planner />} />
        <Route path="alerts" element={<Alerts />} />
        <Route path="journal" element={<Journal />} />
        <Route path="replay" element={<Replay />} />
        <Route path="backtest" element={<Backtest />} />
        <Route path="providers" element={<Providers />} />
        <Route path="settings" element={<Settings />} />
        <Route path="*" element={<Dashboard />} />
      </Route>
    </Routes>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <StoreProvider>
        <Shell />
      </StoreProvider>
    </BrowserRouter>
  </React.StrictMode>,
);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
