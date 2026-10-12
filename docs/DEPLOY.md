# Put ELF on your iPhone — step by step

ELF is an installable web app (PWA):

* It installs from Safari to your Home Screen.
* It opens full-screen with its own icon.
* It receives **push alerts even when it's closed** (iOS 16.4+).

The strategy engine, data feeds and alerts run on a small server in the cloud, so they keep working while your phone is asleep. Total setup time is about 15 minutes.

> **Why not an App Store app?** A native iPhone build needs a Mac with Xcode and an Apple Developer account ($99/year for TestFlight / App Store), and every update has to go through Apple. The installed web app gives you the same screens, the Home Screen icon and push alerts. Updates are instant.

## 1. Before you start

* **Make the GitHub repository private.** It currently is **public**, which means anyone can read your ELF rules and code.
  1. Go to GitHub → `artisdigital/Elf-strategy` → **Settings**.
  2. Under **Danger Zone**, choose **Change visibility → Private**.
  3. No secrets are stored in the repository. Keys live encrypted on the server.
* Choose a strong app password, at least 12 characters (a passphrase is best). It's the only thing protecting your app on the internet.

## 2. Deploy to Render (≈ $7–8/month)

The repository includes a `render.yaml` blueprint that sets up everything:

* **HTTPS**;
* a **1 GB persistent disk** for your journal, settings and keys;
* a US region (Binance.US serves US customers);
* an auto-generated encryption key;
* a required password.

1. Create an account at <https://render.com> and connect your GitHub account. Allow access to the `Elf-strategy` repository; private repos work.
2. Go to **New → Blueprint** and select `artisdigital/Elf-strategy`.
   * Branch: `claude/elf-trading-app`, or `main` once you've merged.
3. Render shows the service **elf-trading**. When it asks for environment values:
   * **ELF_APP_PASSWORD** — your app password.
   * **ELF_VAPID_SUBJECT** (optional) — `mailto:` followed by your email. Push services use it as a contact.
4. Click **Apply**. The first build takes 3–5 minutes.
5. Open the URL Render shows, e.g. `https://elf-trading-xxxx.onrender.com`, and sign in with your password.

What it costs: the **Starter** instance plus the 1 GB disk, about $7–8/month at the time of writing. Check Render's pricing page. The free tier is not suitable: it sleeps when idle, which stops alerts, and it has no persistent disk, so your journal would be lost.

Optional: in Render → **Settings → Custom Domains** you can use your own domain, e.g. `elf.yourdomain.com`. HTTPS is automatic.

## 3. Install on your iPhone

1. Open your Render URL in **Safari**. Other iOS browsers can't install web apps with push.
2. Sign in.
3. Tap **Share** (the square with an arrow) → **Add to Home Screen** → **Add**.
4. Open **ELF** from the Home Screen. From now on, always use this icon.

## 4. Turn on push alerts (iOS 16.4 or later)

1. In the installed app, go to **Alerts** (bottom bar) → **Push notifications** → **Enable push on this device** → **Allow**.
2. Tap **Send test push**. You should receive a notification within seconds. Try it with the app closed, too.
3. Choose what to be alerted about under **What to alert** (all / preliminary / confirmation only / entry only).

Alerts come from the server for markets on your **watch-list** (Settings & Rules → Watch-list). The default is BTCUSD 15m on Binance.US. Add the markets you want watched.

You can enroll more devices (another phone, a laptop browser) the same way. Each one gets every alert.

## 5. Add your data providers

**Market Data** page:

* **Binance.US** works without a key.
* **OANDA** (forex, gold, US30/NAS100): paste a personal API token. A free practice account works. Then press **Test connection**.
* **Alpaca** (US stocks): key ID + secret from a paper account. The free plan uses the IEX feed.

Keys are stored encrypted on the server and never sent back to the browser.

## 6. Day-to-day

* **Updates:** every push to the deployed branch redeploys automatically. Your data on the disk is kept.
* **Backups:** Render → your service → **Disks** → snapshots, or download `/var/data/elf.db` via the Render shell. Keep `ELF_SECRET_KEY` with any backup; stored provider keys can't be decrypted without it.
* **Forgot the password:** change `ELF_APP_PASSWORD` in Render → Environment. The service restarts.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| No "Add to Home Screen" | You must use Safari. In Safari's Share sheet, scroll down the action list. |
| "Push is not available here" | Open ELF from the **Home Screen icon**, not a Safari tab, and update to iOS 16.4+. |
| Test push "sent to 0 devices" | Enable push on the device first (Alerts page). |
| Feed shows ERROR / DISCONNECTED for Binance.US | Binance.US can block some cloud IP ranges or regions. Check **Market Data → Test connection**. Use OANDA/Alpaca, or move the service to another US region. |
| Feed shows REST POLLING | Normal when the WebSocket can't connect; data still updates every 10 s. LIVE appears when the WebSocket stream works. |
| Build fails on Render | Check the build log. The blueprint pins Node 22.22 (`NODE_VERSION`); the app needs Node ≥ 22.13. |

## Running it on your own computer instead (no hosting cost)

```bash
npm install && npm run build
ELF_APP_PASSWORD='your-long-password' npm start      # http://localhost:8787
```

To reach it from your phone, put both devices on a private network such as **Tailscale** (free), then open `http://<computer-name>:8787`. Push and installation need HTTPS, so enable **Tailscale Serve** or **Funnel** for an HTTPS URL. Alerts stop when the computer sleeps.
