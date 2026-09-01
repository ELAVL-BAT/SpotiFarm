const fs = require('fs');
const path = require('path');

const CONFIG_PATH = process.env.CONFIG_PATH || '/config/config.json';
const DEFAULTS = {
  playlists: [
    'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M',
    'https://open.spotify.com/playlist/37i9dQZF1DX0XUsuxWHRQd'
  ],
  autoPlay: true,
  autoTakeover: true,
  shuffle: true,
  watchdogIntervalMs: 15000,
  takeoverDelayMs: 10000,
  playlistRotateMinutes: 60,
  maxSkipsPerHour: 8,
  vnc: true,
};

function loadConfig() {
  let userConfig = {};
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    userConfig = JSON.parse(raw);
    console.log(`[config] loaded from ${CONFIG_PATH}`);
  } catch (e) {
    console.warn(`[config] ${CONFIG_PATH} not found or invalid, using defaults`);
  }
  return { ...DEFAULTS, ...userConfig };
}

function saveConfig(updatedConfig) {
  try {
    const dir = path.dirname(CONFIG_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(updatedConfig, null, 2), 'utf8');
    console.log(`[config] saved to ${CONFIG_PATH}`);
    return true;
  } catch (e) {
    console.error(`[config] failed to save to ${CONFIG_PATH}:`, e.message);
    return false;
  }
}

module.exports = { loadConfig, saveConfig, DEFAULTS };
