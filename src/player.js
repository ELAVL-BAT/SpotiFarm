/**
 * player.js — SpotiFarms playback & user control engine
 *
 * Provides both autonomous farm streaming and full interactive user controls:
 * - Play/Pause, Next, Previous, Shuffle
 * - Play any custom Spotify URL (Track, Album, Playlist, Artist)
 * - Click and play any track from the visible tracklist
 * - Connect Device awareness & non-destructive takeover
 */

class Player {
  constructor(page, config) {
    this.page = page;
    this.config = config;
    this.currentPlaylistIndex = 0;
    this.isPlaying = false;
    this.isYielding = false;
    this.skipsThisHour = 0;
    this.hourStart = Date.now();
    this.startTime = Date.now();
    this.rotateTimer = null;
    this.cachedAccount = null;
    this.lastAccountCheck = 0;
    this.userControlled = false; // When user explicitly changes song/playlist
  }

  // *the needle drops — first contact with audio*
  async start() {
    console.log('[player] initializing playback...');
    if (this.config.autoPlay !== false) {
      await this.navigateToPlaylist(this.config.playlists[0] || 'https://open.spotify.com');
      await this.sleep(rand(2000, 3500));
      await this.startPlaylistPlayback();
    }

    if (this.config.playlists && this.config.playlists.length > 1) {
      this.scheduleRotation();
    }

    this.scheduleRandomSkips();
  }

  async navigateToPlaylist(url) {
    console.log(`[player] navigating to: ${url}`);
    try {
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await this.sleep(rand(2000, 3500));
    } catch (err) {
      console.error('[player] navigation failed:', err.message);
      try {
        await this.page.goto('https://open.spotify.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await this.sleep(2500);
        await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await this.sleep(rand(2000, 3500));
      } catch (retryErr) {
        console.error('[player] retry navigation failed:', retryErr.message);
      }
    }
  }

  /**
   * Play any custom Spotify URL requested by user.
   */
  async playUrl(url) {
    console.log(`[player] 🎯 User requested custom URL: ${url}`);
    this.isYielding = false;
    this.userControlled = true;

    // Convert Spotify URI to web URL if passed in URI format (spotify:track:xxx)
    let targetUrl = url.trim();
    if (targetUrl.startsWith('spotify:')) {
      const parts = targetUrl.split(':');
      if (parts.length >= 3) {
        targetUrl = `https://open.spotify.com/${parts[1]}/${parts[2]}`;
      }
    }

    await this.navigateToPlaylist(targetUrl);
    await this.sleep(1500);
    await this.startPlaylistPlayback();
  }

  /**
   * Clicks a specific track by its 1-based index in the current view.
   */
  async playTrackIndex(index) {
    console.log(`[player] 🎯 User clicked track index: ${index}`);
    this.isYielding = false;
    this.userControlled = true;

    try {
      const rows = await this.page.$$('[data-testid="tracklist-row"]');
      if (rows && rows[index - 1]) {
        const row = rows[index - 1];
        // Double click the row to play it in Spotify Web Player
        await row.scrollIntoViewIfNeeded();
        await row.dblclick();
        console.log(`[player] double-clicked track row #${index}`);
        await this.sleep(1500);
        this.isPlaying = true;
        return;
      }
    } catch (err) {
      console.error('[player] playTrackIndex error:', err.message);
    }
  }

  /**
   * Explicitly starts playback from a playlist/album header button.
   */
  async startPlaylistPlayback() {
    try {
      const playBtn = await this.page.$('[data-testid="play-button"], [data-testid="action-bar-row"] button[data-testid="play-button"]');
      if (playBtn) {
        await playBtn.click();
        console.log('[player] clicked playlist/album play button');
        await this.sleep(1500);
        if (this.config.shuffle) {
          await this.enableShuffle();
        }
        return;
      }
      await this.resume();
    } catch (err) {
      console.error('[player] startPlaylistPlayback failed:', err.message);
      await this.resume();
    }
  }

  /**
   * Resumes currently loaded track/queue without resetting playlist or changing songs.
   */
  async resume() {
    if (this.isYielding) return;
    console.log('[player] resuming current playback (preserving track)...');

    try {
      // 1. If Connect Bar is active, transfer to this browser
      const transferBtn = await this.page.$('[data-testid="connect-bar"] button, button[aria-label*="Listen on" i], button[aria-label*="Play here" i]');
      if (transferBtn) {
        await transferBtn.click();
        await this.sleep(1000);
      }

      // 2. Click the bottom bar play button (resumes exact current track)
      const controlPlay = await this.page.$('[data-testid="control-button-playpause"]');
      if (controlPlay) {
        const label = await controlPlay.getAttribute('aria-label');
        if (label && label.toLowerCase().includes('play')) {
          await controlPlay.click();
          console.log('[player] clicked bottom bar play (resumed track)');
          this.isPlaying = true;
          return;
        } else if (label && label.toLowerCase().includes('pause')) {
          this.isPlaying = true;
          return;
        }
      }

      // 3. Spacebar fallback to unpause without navigation
      await this.page.keyboard.press('Space');
      console.log('[player] sent spacebar to unpause');
      this.isPlaying = true;
    } catch (err) {
      console.error('[player] resume failed:', err.message);
    }
  }

  async pause() {
    console.log('[player] pausing playback...');
    try {
      const controlBtn = await this.page.$('[data-testid="control-button-playpause"]');
      if (controlBtn) {
        const label = await controlBtn.getAttribute('aria-label');
        if (label && label.toLowerCase().includes('pause')) {
          await controlBtn.click();
          console.log('[player] paused via control button');
          this.isPlaying = false;
          return;
        }
      }
      await this.page.keyboard.press('Space');
      this.isPlaying = false;
    } catch (err) {
      console.error('[player] pause failed:', err.message);
    }
  }

  async previousTrack() {
    console.log('[player] previous track...');
    try {
      const prevBtn = await this.page.$('[data-testid="control-button-skip-back"]');
      if (prevBtn) {
        await prevBtn.click();
        console.log('[player] clicked previous track button');
      }
    } catch (err) {
      console.error('[player] previousTrack failed:', err.message);
    }
  }

  async skipTrack() {
    if (this.isYielding) return;

    if (Date.now() - this.hourStart > 3600000) {
      this.skipsThisHour = 0;
      this.hourStart = Date.now();
    }

    if (this.skipsThisHour >= this.config.maxSkipsPerHour) {
      console.log('[player] skip limit reached this hour, waiting...');
      return;
    }

    try {
      const nextBtn = await this.page.$('[data-testid="control-button-skip-forward"]');
      if (nextBtn) {
        await nextBtn.click();
        this.skipsThisHour++;
        console.log(`[player] skipped track (${this.skipsThisHour}/${this.config.maxSkipsPerHour} this hour)`);
      }
    } catch (err) {
      console.error('[player] skipTrack failed:', err.message);
    }
  }

  async enableShuffle() {
    try {
      const shuffleBtn = await this.page.$('[data-testid="control-button-shuffle"]');
      if (shuffleBtn) {
        const checked = await shuffleBtn.getAttribute('aria-checked');
        if (checked !== 'true') {
          await shuffleBtn.click();
          console.log('[player] shuffle enabled');
        }
      }
    } catch (err) {
      console.error('[player] enableShuffle failed:', err.message);
    }
  }

  async rotatePlaylist() {
    if (!this.config.playlists || this.config.playlists.length <= 1) return;
    this.currentPlaylistIndex = (this.currentPlaylistIndex + 1) % this.config.playlists.length;
    const nextPlaylist = this.config.playlists[this.currentPlaylistIndex];
    console.log(`[player] rotating to playlist ${this.currentPlaylistIndex}: ${nextPlaylist}`);
    await this.navigateToPlaylist(nextPlaylist);
    await this.sleep(rand(1500, 2500));
    await this.startPlaylistPlayback();
  }

  scheduleRotation() {
    const intervalMs = (this.config.playlistRotateMinutes || 60) * 60 * 1000;
    if (this.rotateTimer) clearInterval(this.rotateTimer);

    this.rotateTimer = setInterval(async () => {
      if (this.isYielding) {
        console.log('[player] skipping playlist rotation (external device is active)');
        return;
      }
      if (this.userControlled) {
        console.log('[player] skipping playlist rotation (user is controlling playback)');
        return;
      }
      await this.rotatePlaylist();
    }, intervalMs);
  }

  scheduleRandomSkips() {
    const loop = async () => {
      const delay = rand(120000, 480000);
      await this.sleep(delay);
      if (!this.isYielding && Math.random() < 0.35) {
        await this.skipTrack();
      }
      loop();
    };
    loop();
  }

  /**
   * Extracts account information from the Spotify Web Player DOM.
   */
  async getAccountInfo() {
    if (this.cachedAccount && (Date.now() - this.lastAccountCheck < 30000)) {
      return this.cachedAccount;
    }

    try {
      const account = await this.page.evaluate(() => {
        const userWidget = document.querySelector('[data-testid="user-widget-link"]') ||
                           document.querySelector('button[data-testid="user-widget-dropdown-button"]') ||
                           document.querySelector('[data-testid="username-element"]') ||
                           document.querySelector('figure[data-testid="user-widget-avatar"]')?.parentElement;

        let username = null;
        let avatarUrl = null;
        let isLoggedIn = false;

        if (userWidget) {
          isLoggedIn = true;
          username = userWidget.getAttribute('aria-label') ||
                     userWidget.querySelector('span')?.textContent ||
                     userWidget.textContent?.trim() ||
                     'Spotify User';

          username = username.replace(/^user:\s*/i, '').replace(/profile$/i, '').trim();

          const img = userWidget.querySelector('img') ||
                      document.querySelector('figure[data-testid="user-widget-avatar"] img') ||
                      document.querySelector('[data-testid="user-widget-link"] img');
          if (img) {
            avatarUrl = img.getAttribute('src') || img.src;
          }
        } else {
          const loginBtn = document.querySelector('[data-testid="login-button"]');
          isLoggedIn = !loginBtn;
          if (isLoggedIn) username = 'Active Session';
        }

        return {
          username: username || 'Spotify User',
          avatarUrl: avatarUrl || null,
          isLoggedIn,
        };
      });

      this.cachedAccount = account;
      this.lastAccountCheck = Date.now();
      return account;
    } catch (err) {
      return {
        username: 'Spotify Account',
        avatarUrl: null,
        isLoggedIn: true,
      };
    }
  }

  /**
   * Reads full device, connect, and playback state from the Web Player DOM.
   */
  async getDeviceAndPlaybackState() {
    try {
      return await this.page.evaluate(() => {
        const connectBar = document.querySelector('[data-testid="connect-bar"]');
        const connectBarText = connectBar ? (connectBar.textContent || '') : '';

        const devicePicker = document.querySelector('[data-testid="device-picker-icon-button"]') ||
                             document.querySelector('[data-testid="control-button-device-picker"]') ||
                             document.querySelector('button[aria-label*="device" i]') ||
                             document.querySelector('button[aria-label*="Listening on" i]') ||
                             document.querySelector('button[aria-label*="Connected to" i]');
        const devicePickerAria = devicePicker ? (devicePicker.getAttribute('aria-label') || '') : '';

        let isExternalDevice = false;
        let externalDeviceName = null;

        if (connectBarText && /listening on/i.test(connectBarText)) {
          const match = connectBarText.match(/listening on\s+(.*)/i);
          const targetName = match ? match[1].trim() : connectBarText.trim();
          if (!/web player|this (web |internet )?browser|this computer/i.test(targetName)) {
            isExternalDevice = true;
            externalDeviceName = targetName;
          }
        } else if (devicePickerAria && (/listening on/i.test(devicePickerAria) || /connected to/i.test(devicePickerAria))) {
          if (!/web player|this (web |internet )?browser|this computer/i.test(devicePickerAria)) {
            isExternalDevice = true;
            externalDeviceName = devicePickerAria;
          }
        }

        const playPauseBtn = document.querySelector('[data-testid="control-button-playpause"]');
        const playPauseLabel = playPauseBtn ? (playPauseBtn.getAttribute('aria-label') || '') : '';
        const isPlaying = playPauseLabel ? playPauseLabel.toLowerCase().includes('pause') : false;

        const trackEl = document.querySelector('[data-testid="context-item-info-title"] a') ||
                        document.querySelector('[data-testid="context-item-info-title"]');
        const trackName = trackEl ? trackEl.textContent.trim() : null;

        const artistEl = document.querySelector('[data-testid="context-item-info-artist"]') ||
                         document.querySelector('[data-testid="context-item-info-subtitles"]');
        const artistName = artistEl ? artistEl.textContent.trim() : null;

        const coverImg = document.querySelector('[data-testid="cover-art-image"]') ||
                         document.querySelector('[data-testid="now-playing-widget"] img') ||
                         document.querySelector('[data-testid="track-info-artwork"] img');
        const coverArt = coverImg ? (coverImg.getAttribute('src') || coverImg.src) : null;

        let progress = null;
        const progressBar = document.querySelector('[data-testid="playback-progressbar"]');
        if (progressBar) {
          const style = progressBar.getAttribute('style') || '';
          const match = style.match(/(\d+(\.\d+)?)%/);
          if (match) progress = parseFloat(match[1]);
        }

        const timeElapsed = document.querySelector('[data-testid="playback-position"]')?.textContent || null;
        const timeRemaining = document.querySelector('[data-testid="playback-duration"]')?.textContent || null;

        const playlistHeader = document.querySelector('[data-testid="entityTitle"] h1') ||
                               document.querySelector('h1[data-encore-id="type"]') ||
                               document.querySelector('h1');
        const playlistTitle = playlistHeader ? playlistHeader.textContent.trim() : null;

        return {
          isPlaying,
          isExternalDevice,
          externalDeviceName,
          trackName,
          artistName,
          coverArt,
          progress,
          timeElapsed,
          timeRemaining,
          playlistTitle,
        };
      });
    } catch (err) {
      console.error('[player] getDeviceAndPlaybackState error:', err.message);
      return {
        isPlaying: false,
        isExternalDevice: false,
        externalDeviceName: null,
        trackName: null,
        artistName: null,
        coverArt: null,
        progress: null,
        timeElapsed: null,
        timeRemaining: null,
        playlistTitle: null,
      };
    }
  }

  /**
   * Scrapes currently visible tracks on the playlist page for the WebUI.
   */
  async getPlaylistTracks() {
    try {
      return await this.page.evaluate(() => {
        const rows = document.querySelectorAll('[data-testid="tracklist-row"]');
        const tracks = [];
        rows.forEach((row, index) => {
          if (index >= 30) return;
          const title = row.querySelector('div[aria-colindex="2"] div[dir="auto"]')?.textContent ||
                        row.querySelector('a[data-testid="internal-track-link"] div')?.textContent ||
                        row.querySelector('div[data-encore-id="type"]')?.textContent;
          const artist = row.querySelector('div[aria-colindex="2"] span a')?.textContent ||
                         row.querySelector('div[aria-colindex="2"] span')?.textContent;
          const duration = row.querySelector('div[aria-colindex="4"] div')?.textContent ||
                           row.querySelector('div[aria-colindex="5"] div')?.textContent;

          if (title) {
            tracks.push({
              index: index + 1,
              title: title.trim(),
              artist: artist ? artist.trim() : 'Unknown Artist',
              duration: duration ? duration.trim() : '',
            });
          }
        });
        return tracks;
      });
    } catch {
      return [];
    }
  }

  /**
   * Takes over playback to this Dockerized Chromium instance without destroying current track/queue.
   */
  async takeOver() {
    this.isYielding = false;
    console.log('[player] ⚡ Taking over playback on Dockerized Spotify Web Player...');

    try {
      // 1. Transfer to this browser if connect bar is active
      const transferBtn = await this.page.$('[data-testid="connect-bar"] button, button[aria-label*="Listen on" i], button[aria-label*="Play here" i]');
      if (transferBtn) {
        await transferBtn.click();
        await this.sleep(1000);
      }

      // 2. Resume currently loaded track / queue
      await this.resume();
      await this.sleep(1500);

      const state = await this.getDeviceAndPlaybackState();
      this.isPlaying = state.isPlaying;

      // 3. Only if completely empty/idle with no track loaded, load default playlist
      if (!state.isPlaying && !state.trackName) {
        console.log('[player] no track queued on takeover — loading target playlist...');
        await this.fullRestart();
      }
    } catch (err) {
      console.error('[player] takeOver failed:', err.message);
    }
  }

  async fullRestart() {
    if (this.isYielding) return;
    console.log('[player] full restart — loading playlist...');
    this.isYielding = false;
    const playlist = (this.config.playlists && this.config.playlists[this.currentPlaylistIndex]) || 'https://open.spotify.com';
    await this.navigateToPlaylist(playlist);
    await this.sleep(rand(1500, 2500));
    await this.startPlaylistPlayback();
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

module.exports = { Player };
