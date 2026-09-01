const { chromium } = require('playwright');
const { loadConfig } = require('./config');
const { Player } = require('./player');
const { Watchdog } = require('./watchdog');
const { startServer } = require('./server');

const PROFILE_DIR = process.env.PROFILE_DIR || '/data/chrome-profile';
const WEBUI_PORT = parseInt(process.env.WEBUI_PORT || '3000', 10);

// *the main loop breathes life into the headless shell*
async function main() {
  const config = loadConfig();
  console.log('[main] SpotiFarms starting...');
  console.log('[main] playlists:', config.playlists);

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false, // needs Xvfb — Spotify detects headless and throttles
    viewport: { width: 1280, height: 720 },
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    args: [
      // ── sandbox ───────────────────────────────────────────
      '--no-sandbox',
      '--disable-setuid-sandbox',

      // ── memory: merge all renderer into main process ───────
      '--single-process',
      '--no-zygote',

      // ── memory: kill crash reporter ───────────────────────
      '--disable-crash-reporter',
      '--noerrdialogs',
      // ── memory: cap V8 JS heap ────────────────────────────
      '--js-flags=--max-old-space-size=128',

      // ── memory: shared mem + GPU ──────────────────────────
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--disable-gpu-sandbox',

      // ── memory: kill background services ──────────────────
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-media-suspend',
      '--disable-client-side-phishing-detection',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-hang-monitor',
      '--disable-popup-blocking',
      '--disable-prompt-on-repost',
      '--disable-sync',
      '--disable-translate',
      '--disable-web-resources',
      '--metrics-recording-only',
      '--no-first-run',
      '--safebrowsing-disable-auto-update',
      '--password-store=basic',

      // ── memory: disable unneeded features ─────────────────
      '--disable-features=Translate,OptimizationHints,CalculateNativeWinOcclusion,InterestFeedContentSuggestions,CertificateTransparencyComponentUpdater,AutofillServerCommunication,PrivacySandboxSettings4,AudioServiceOutOfProcess,IsolateOrigins,site-per-process',
      '--enable-features=NetworkServiceInProcess',

      // ── anti-detection ────────────────────────────────────
      '--disable-blink-features=AutomationControlled',

      // ── audio: let it play into PulseAudio null sink ──────
      '--autoplay-policy=no-user-gesture-required',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });

  // patch navigator.webdriver away
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5],
    });
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
    });
  });

  const page = await context.newPage();

  // block heavy media assets we don't need — save bandwidth, allow critical Spotify scripts/styles/api
  await page.route('**/*.{woff,woff2,mp4,webm}', (route) => route.abort());
  await page.route('**/*', (route) => {
    return route.continue();
  });

  console.log('[main] navigating to Spotify Web Player...');
  await page.goto('https://open.spotify.com', { waitUntil: 'domcontentloaded', timeout: 60000 });

  // detect login state
  const needsLogin = await detectLoginRequired(page);
  if (needsLogin) {
    console.log('[main] *** LOGIN REQUIRED ***');
    console.log('[main] Open VNC at http://localhost:6080 and login manually.');
    console.log('[main] Waiting for login to complete...');
    await waitForLogin(page);
    console.log('[main] Login detected! Continuing...');
  } else {
    console.log('[main] Already logged in (session cookies found)');
  }

  // give Spotify a moment to hydrate after login
  await page.waitForTimeout(3000);

  const player = new Player(page, config);
  const watchdog = new Watchdog(page, player, config);

  // Start the WebUI dashboard server on port 3000
  startServer({ player, watchdog, config, port: WEBUI_PORT });

  await player.start();
  watchdog.start();

  console.log(`[main] SpotiFarms running. Dashboard available at http://localhost:${WEBUI_PORT}`);

  // keep process alive — watchdog handles recovery
  await new Promise(() => {});
}

async function detectLoginRequired(page) {
  try {
    await page.waitForTimeout(5000);
    const url = page.url();
    if (url.includes('accounts.spotify.com') || url.includes('/login')) {
      return true;
    }
    const loginBtn = await page.$('[data-testid="login-button"]');
    if (loginBtn) return true;
    const playerBar = await page.$('[data-testid="now-playing-bar"]');
    if (playerBar) return false;
    const footerPlayer = await page.$('[data-testid="player-controls"]');
    if (footerPlayer) return false;
    const userWidget = await page.$('[data-testid="user-widget-link"]');
    return !userWidget;
  } catch {
    return true;
  }
}

async function waitForLogin(page) {
  while (true) {
    await page.waitForTimeout(5000);
    const url = page.url();
    if (url.includes('open.spotify.com') && !url.includes('login') && !url.includes('accounts.spotify.com')) {
      const playerBar = await page.$('[data-testid="now-playing-bar"]');
      const userWidget = await page.$('[data-testid="user-widget-link"]');
      if (playerBar || userWidget) return;
    }
  }
}

main().catch((err) => {
  console.error('[main] fatal:', err);
  process.exit(1);
});
