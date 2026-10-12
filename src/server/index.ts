import path from 'node:path';
import { createApp, createContext, startBackground, stopBackground } from './app.js';

const port = Number(process.env.ELF_PORT ?? process.env.PORT ?? 8787);
const dataDir = path.resolve(process.env.ELF_DATA_DIR ?? './data');

const ctx = createContext({ dataDir });
const app = createApp(ctx);
const server = app.listen(port, () => {
  console.log(`ELF Trading App listening on http://localhost:${port}  (data: ${dataDir}, auth: ${ctx.auth.enabled ? 'password' : 'OFF'})`);
  if (!ctx.auth.enabled && process.env.NODE_ENV === 'production') {
    console.warn('WARNING: ELF_APP_PASSWORD is not set. Do not expose this server to the internet without it.');
  }
  startBackground(ctx);
});

function shutdown() {
  stopBackground(ctx);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
