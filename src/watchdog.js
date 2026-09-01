/**
 * watchdog.js — SpotiFarms smart health & Connect monitor
 *
 * Respects user playback choices:
 * - If user changes songs/playlists, watchdog keeps playing the user's choice.
 * - When playback pauses, watchdog gently resumes the current track rather than resetting.
 * - Auto-takeover reclaims audio politely without hijacking user sessions.
 */

class Watchdog {
  constructor(page, player, config) {
    this.page = page;
    this.player = player;
    this.config = config;
    this.interval = null;
    this.failCount = 0;
    this.lastTrackName = null;
    this.lastProgress = null;
    this.stuckCount = 0;
    this.maxFails = 6;
    this.maxStuck = 4;

    // Connect & Yield state
    this.isYieldingToExternal = false;
    this.externalStoppedTimestamp = null;
    this.lastExternalDeviceName = null;
  }

  start() {
    const interval = this.config.watchdogIntervalMs || 15000;
    console.log(`[watchdog] starting — interval ${interval}ms (takeover grace: ${this.config.takeoverDelayMs || 10000}ms)`);
    this.interval = setInterval(() => this.check(), interval);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  // *the sentinel watches the airwaves — yielding to the master, claiming the void*
  async check() {
    try {
      // 1. Page responsiveness check
      const alive = await this.isPageAlive();
      if (!alive) {
        console.error('[watchdog] page unresponsive!');
        this.failCount++;
        if (this.failCount >= this.maxFails) {
          console.error('[watchdog] too many failures — killing process for Docker restart');
          process.exit(1);
        }
        return;
      }

      // 2. Session validity check
      const sessionValid = await this.isSessionValid();
      if (!sessionValid) {
        console.error('[watchdog] session expired! Need re-login via VNC at http://localhost:6080/vnc.html');
        return;
      }

      // 3. Query device and playback state
      const state = await this.player.getDeviceAndPlaybackState();

      // ────────────────────────────────────────────────────────────────
      // SCENARIO 1: Other device is actively listening
      // ────────────────────────────────────────────────────────────────
      if (state.isExternalDevice && state.isPlaying) {
        this.isYieldingToExternal = true;
        this.player.isYielding = true;
        this.externalStoppedTimestamp = null;
        this.lastExternalDeviceName = state.externalDeviceName || 'External device';
        this.failCount = 0;
        this.stuckCount = 0;

        if (Math.random() < 0.25) {
          console.log(`[watchdog] 🎧 User listening on "${this.lastExternalDeviceName}" ("${state.trackName || 'unknown'}"). Waiting quietly...`);
        }
        return;
      }

      // ────────────────────────────────────────────────────────────────
      // SCENARIO 2: Was yielding to other device, but now other device paused/stopped
      // ────────────────────────────────────────────────────────────────
      if (this.isYieldingToExternal && (!state.isPlaying || !state.isExternalDevice)) {
        if (this.config.autoTakeover === false) {
          // Auto takeover disabled by user
          return;
        }

        const graceMs = this.config.takeoverDelayMs || 10000;

        if (!this.externalStoppedTimestamp) {
          this.externalStoppedTimestamp = Date.now();
          console.log(`[watchdog] ⏳ "${this.lastExternalDeviceName}" paused/stopped. Waiting ${Math.round(graceMs / 1000)}s grace period before takeover...`);
          return;
        }

        const elapsed = Date.now() - this.externalStoppedTimestamp;
        if (elapsed < graceMs) {
          console.log(`[watchdog] ⏳ Waiting grace period (${Math.round((graceMs - elapsed) / 1000)}s remaining)...`);
          return;
        }

        console.log(`[watchdog] ⚡ Other device idle. Taking over playback without resetting song...`);
        this.isYieldingToExternal = false;
        this.player.isYielding = false;
        this.externalStoppedTimestamp = null;
        this.failCount = 0;
        this.stuckCount = 0;

        await this.player.takeOver();
        return;
      }

      // ────────────────────────────────────────────────────────────────
      // SCENARIO 3: No external device active, but Docker Chromium is NOT playing
      // ────────────────────────────────────────────────────────────────
      if (!state.isPlaying) {
        if (this.config.autoPlay === false) {
          return;
        }

        this.failCount++;
        console.warn(`[watchdog] ⚠️ Playback idle on Docker (attempt ${this.failCount}/${this.maxFails})`);

        if (this.failCount <= 3) {
          // Gentle: resume whatever track is currently loaded without navigating away
          await this.player.resume();
        } else if (this.failCount <= this.maxFails) {
          // If still paused and user hasn't chosen a custom song, restart playlist
          if (!this.player.userControlled) {
            await this.player.fullRestart();
          } else {
            await this.player.resume();
          }
        } else {
          console.error('[watchdog] exhausted recovery attempts — exiting for Docker restart');
          process.exit(1);
        }
        return;
      }

      // ────────────────────────────────────────────────────────────────
      // SCENARIO 4: Docker Chromium is actively playing locally
      // ────────────────────────────────────────────────────────────────
      this.isYieldingToExternal = false;
      this.player.isYielding = false;
      this.externalStoppedTimestamp = null;
      this.failCount = 0;

      // Stuck progress check
      if (state.progress !== null && state.progress === this.lastProgress) {
        this.stuckCount++;
        console.warn(`[watchdog] progress stuck at ${state.progress}% (count: ${this.stuckCount})`);
        if (this.stuckCount >= this.maxStuck) {
          console.warn('[watchdog] stuck too long — unsticking track');
          await this.player.skipTrack();
          this.stuckCount = 0;
        }
      } else {
        this.stuckCount = 0;
      }

      this.lastTrackName = state.trackName;
      this.lastProgress = state.progress;

      if (Math.random() < 0.2) {
        console.log(`[watchdog] ♥ Playing: "${state.trackName || 'unknown'}" @ ${state.progress || '?'}%`);
      }

    } catch (err) {
      console.error('[watchdog] check error:', err.message);
      this.failCount++;
      if (this.failCount >= this.maxFails) {
        console.error('[watchdog] fatal — exiting');
        process.exit(1);
      }
    }
  }

  async isPageAlive() {
    try {
      await this.page.evaluate(() => document.title, { timeout: 10000 });
      return true;
    } catch {
      return false;
    }
  }

  async isSessionValid() {
    try {
      const url = this.page.url();
      if (url.includes('accounts.spotify.com') || url.includes('/login')) {
        return false;
      }
      const loginBtn = await this.page.$('[data-testid="login-button"]');
      return !loginBtn;
    } catch {
      return false;
    }
  }
}

module.exports = { Watchdog };
