/**
 * app.js — SpotiFarms Dashboard Frontend Logic
 */

let currentConfig = null;
let pollTimer = null;

document.addEventListener('DOMContentLoaded', () => {
  initEventListeners();
  fetchStatus();
  pollTimer = setInterval(fetchStatus, 2000);
});

function initEventListeners() {
  // Playback Control Buttons
  document.getElementById('btnPlay').addEventListener('click', () => sendAction('play'));
  document.getElementById('btnPause').addEventListener('click', () => sendAction('pause'));
  document.getElementById('btnSkip').addEventListener('click', () => sendAction('skip'));
  document.getElementById('btnPrev').addEventListener('click', () => sendAction('previous'));
  document.getElementById('btnTakeover').addEventListener('click', () => sendAction('takeover'));

  // Custom URL Player
  const customUrlInput = document.getElementById('customPlayUrlInput');
  const btnPlayCustomUrl = document.getElementById('btnPlayCustomUrl');

  const handleCustomPlay = () => {
    const url = customUrlInput.value.trim();
    if (!url) {
      showToast('⚠️ Please enter a Spotify URL first');
      return;
    }
    sendAction('play_url', { url });
    showToast(`🎯 Loading: ${url}`);
  };

  btnPlayCustomUrl.addEventListener('click', handleCustomPlay);
  customUrlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleCustomPlay();
  });

  // Config Form
  document.getElementById('btnSaveConfig').addEventListener('click', saveSettings);
  document.getElementById('btnAddPlaylist').addEventListener('click', () => addPlaylistRow(''));
}

async function fetchStatus() {
  try {
    const res = await fetch('/api/status');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    renderDashboard(data);
  } catch (err) {
    console.warn('Status poll error:', err.message);
    const statusBadge = document.getElementById('connectStatusBadge');
    if (statusBadge) {
      statusBadge.innerHTML = `<span class="dot" style="background:#ef4444"></span><span class="status-text" style="color:#ef4444">Connecting...</span>`;
    }
  }
}

function renderDashboard(data) {
  const { account, playback, playlistTracks, config, stats } = data;

  // 1. Account Info
  const userNameEl = document.getElementById('userName');
  const userAvatarEl = document.getElementById('userAvatar');
  const avatarFallbackEl = document.getElementById('avatarFallback');

  if (account && account.username) {
    userNameEl.textContent = account.username;
  } else {
    userNameEl.textContent = 'Spotify Web Player';
  }

  if (account && account.avatarUrl) {
    userAvatarEl.src = account.avatarUrl;
    userAvatarEl.classList.remove('hidden');
    avatarFallbackEl.classList.add('hidden');
  } else {
    userAvatarEl.classList.add('hidden');
    avatarFallbackEl.classList.remove('hidden');
  }

  // Active Device / Connect Badge
  const activeDeviceTag = document.getElementById('activeDeviceTag');
  const connectStatusBadge = document.getElementById('connectStatusBadge');

  if (playback.isExternalDevice && playback.isPlaying) {
    activeDeviceTag.textContent = `📱 ${playback.externalDeviceName || 'External Device'} (Yielding)`;
    activeDeviceTag.style.color = 'var(--accent-amber)';
    connectStatusBadge.innerHTML = `<span class="dot yielding"></span><span class="status-text" style="color:var(--accent-amber)">External Active</span>`;
  } else if (playback.isPlaying) {
    activeDeviceTag.textContent = `🎧 Docker Chromium Web Player`;
    activeDeviceTag.style.color = 'var(--spotify-green)';
    connectStatusBadge.innerHTML = `<span class="dot active"></span><span class="status-text">Streaming</span>`;
  } else {
    activeDeviceTag.textContent = `⏸️ Idle / Ready`;
    activeDeviceTag.style.color = 'var(--text-muted)';
    connectStatusBadge.innerHTML = `<span class="dot"></span><span class="status-text" style="color:var(--text-muted)">Idle</span>`;
  }

  // 2. Track & Playback Showcase
  const trackTitleEl = document.getElementById('trackTitle');
  const trackArtistEl = document.getElementById('trackArtist');
  const trackCoverArtEl = document.getElementById('trackCoverArt');
  const coverFallbackEl = document.getElementById('coverFallback');
  const eqVisualizerEl = document.getElementById('eqVisualizer');
  const progressBarEl = document.getElementById('progressBar');
  const timeElapsedEl = document.getElementById('timeElapsed');
  const timeRemainingEl = document.getElementById('timeRemaining');
  const currentPlaylistNameEl = document.getElementById('currentPlaylistName');

  trackTitleEl.textContent = playback.trackName || 'No Track Playing';
  trackArtistEl.textContent = playback.artistName || (playback.isPlaying ? 'Spotify Web Player' : 'Playback paused');
  currentPlaylistNameEl.textContent = playback.playlistTitle || (playback.currentPlaylistUrl ? 'Active Playlist' : 'Spotify');

  if (playback.coverArt) {
    trackCoverArtEl.src = playback.coverArt;
    trackCoverArtEl.classList.remove('hidden');
    coverFallbackEl.classList.add('hidden');
  } else {
    trackCoverArtEl.classList.add('hidden');
    coverFallbackEl.classList.remove('hidden');
  }

  // Equalizer visualizer
  if (playback.isPlaying) {
    eqVisualizerEl.classList.add('playing');
  } else {
    eqVisualizerEl.classList.remove('playing');
  }

  // Progress
  const progressPercent = playback.progress !== null ? playback.progress : 0;
  progressBarEl.style.width = `${progressPercent}%`;
  timeElapsedEl.textContent = playback.timeElapsed || '0:00';
  timeRemainingEl.textContent = playback.timeRemaining || '';

  // 3. Playlist Tracks (Interactive clickable)
  renderTracklist(playlistTracks, playback.trackName);

  // 4. Stats & Uptime
  if (stats && stats.uptimeSeconds !== undefined) {
    document.getElementById('uptimeVal').textContent = formatSeconds(stats.uptimeSeconds);
  }

  // 5. Initial populate of settings form
  if (!currentConfig && config) {
    currentConfig = config;
    populateConfigForm(config);
  }
}

function renderTracklist(tracks, currentTrackTitle) {
  const container = document.getElementById('tracklistContainer');
  const countEl = document.getElementById('trackCount');

  if (!tracks || tracks.length === 0) {
    container.innerHTML = `<div class="empty-state">No playlist tracklist loaded from page yet.</div>`;
    countEl.textContent = '0 tracks';
    return;
  }

  countEl.textContent = `${tracks.length} tracks`;
  container.innerHTML = tracks.map(t => {
    const isActive = currentTrackTitle && t.title && currentTrackTitle.toLowerCase().includes(t.title.toLowerCase());
    return `
      <div class="track-row ${isActive ? 'active-track' : ''}" data-track-index="${t.index}" title="Click to play this track">
        <div class="track-row-left">
          <span class="track-num">${isActive ? '▶' : t.index}</span>
          <div class="track-titles">
            <div class="row-title">${escapeHtml(t.title)}</div>
            <div class="row-artist">${escapeHtml(t.artist)}</div>
          </div>
        </div>
        <div class="row-duration">${escapeHtml(t.duration)}</div>
      </div>
    `;
  }).join('');

  // Attach click events to rows
  container.querySelectorAll('.track-row').forEach(row => {
    row.addEventListener('click', () => {
      const idx = row.getAttribute('data-track-index');
      sendAction('play_track', { index: idx });
      showToast(`▶ Playing track #${idx}...`);
    });
  });
}

function populateConfigForm(cfg) {
  document.getElementById('cfgAutoPlay').checked = cfg.autoPlay !== false;
  document.getElementById('cfgAutoTakeover').checked = cfg.autoTakeover !== false;
  document.getElementById('cfgShuffle').checked = cfg.shuffle !== false;
  document.getElementById('cfgTakeoverDelay').value = Math.round((cfg.takeoverDelayMs || 10000) / 1000);
  document.getElementById('cfgRotateMinutes').value = cfg.playlistRotateMinutes || 60;
  document.getElementById('cfgMaxSkips').value = cfg.maxSkipsPerHour || 8;

  const playlistsList = document.getElementById('playlistsList');
  playlistsList.innerHTML = '';
  const playlists = cfg.playlists || [];
  if (playlists.length === 0) {
    addPlaylistRow('');
  } else {
    playlists.forEach(url => addPlaylistRow(url));
  }
}

function addPlaylistRow(url = '') {
  const list = document.getElementById('playlistsList');
  const row = document.createElement('div');
  row.className = 'playlist-input-row';
  row.innerHTML = `
    <input type="text" class="playlist-url-input" placeholder="https://open.spotify.com/playlist/..." value="${escapeHtml(url)}">
    <button type="button" class="btn btn-remove-playlist" title="Remove Playlist">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="18" y1="6" x2="6" y2="18"></line>
        <line x1="6" y1="6" x2="18" y2="18"></line>
      </svg>
    </button>
  `;

  row.querySelector('.btn-remove-playlist').addEventListener('click', () => {
    row.remove();
    if (list.children.length === 0) addPlaylistRow('');
  });

  list.appendChild(row);
}

async function saveSettings(e) {
  if (e) e.preventDefault();

  const playlistInputs = document.querySelectorAll('.playlist-url-input');
  const playlists = Array.from(playlistInputs)
    .map(i => i.value.trim())
    .filter(u => u.length > 0);

  const updated = {
    autoPlay: document.getElementById('cfgAutoPlay').checked,
    autoTakeover: document.getElementById('cfgAutoTakeover').checked,
    shuffle: document.getElementById('cfgShuffle').checked,
    takeoverDelayMs: parseInt(document.getElementById('cfgTakeoverDelay').value, 10) * 1000 || 10000,
    playlistRotateMinutes: parseInt(document.getElementById('cfgRotateMinutes').value, 10) || 60,
    maxSkipsPerHour: parseInt(document.getElementById('cfgMaxSkips').value, 10) || 8,
    playlists: playlists.length > 0 ? playlists : ['https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M'],
  };

  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updated),
    });

    const data = await res.json();
    if (data.success) {
      currentConfig = data.config;
      showToast('✅ Settings saved and applied live!');
    } else {
      showToast('❌ Error: ' + (data.error || 'Failed to save'));
    }
  } catch (err) {
    showToast('❌ Save error: ' + err.message);
  }
}

async function sendAction(action, payload = {}) {
  try {
    const res = await fetch('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, payload }),
    });
    const data = await res.json();
    if (data.success) {
      showToast(`⚡ Action "${action}" executed`);
      setTimeout(fetchStatus, 500);
    } else {
      showToast(`❌ Error: ${data.error}`);
    }
  } catch (err) {
    showToast(`❌ Failed to send action: ${err.message}`);
  }
}

function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), 3500);
}

function formatSeconds(sec) {
  const hrs = Math.floor(sec / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  const secs = sec % 60;
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
}
