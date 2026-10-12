import { useEffect, useState } from 'react';
import { isIos, isStandalone } from '../lib/push';

const KEY = 'elf.installDismissed';

/** Install hint: iPhone shows "Share → Add to Home Screen"; Android/desktop Chrome get a one-tap Install button. */
export function InstallPrompt() {
  const [deferred, setDeferred] = useState<any>(null);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(KEY) === '1';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    const h = (e: Event) => {
      e.preventDefault();
      setDeferred(e);
    };
    window.addEventListener('beforeinstallprompt', h);
    return () => window.removeEventListener('beforeinstallprompt', h);
  }, []);
  if (dismissed || isStandalone()) return null;
  const close = () => {
    setDismissed(true);
    try {
      localStorage.setItem(KEY, '1');
    } catch {
      /* private mode */
    }
  };
  if (isIos()) {
    return (
      <div className="install">
        <span>
          <strong>Install ELF:</strong> tap <ShareIcon /> <em>Share</em> → <em>Add to Home Screen</em>. The installed app runs full-screen and can receive push alerts (iOS 16.4+).
        </span>
        <button className="btn btn-sm btn-ghost" onClick={close} aria-label="Dismiss">✕</button>
      </div>
    );
  }
  if (!deferred) return null;
  return (
    <div className="install">
      <span><strong>Install ELF</strong> as an app on this device.</span>
      <button className="btn btn-sm btn-primary" onClick={async () => { deferred.prompt(); await deferred.userChoice; setDeferred(null); close(); }}>Install</button>
      <button className="btn btn-sm btn-ghost" onClick={close} aria-label="Dismiss">✕</button>
    </div>
  );
}

function ShareIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" style={{ verticalAlign: '-2px' }}>
      <path d="M12 3v12M8 7l4-4 4 4M5 12v8h14v-8" />
    </svg>
  );
}
