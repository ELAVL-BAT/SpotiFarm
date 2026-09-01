/**
 * server.js — SpotiFarms Dashboard & Config API Server
 *
 * Lightweight HTTP server serving the WebUI and JSON API endpoints.
 * Zero external npm dependencies (uses native Node.js http, fs, path).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { saveConfig } = require('./config');

const WEBUI_DIR = path.join(__dirname, 'webui');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function startServer({ player, watchdog, config, port = 3000 }) {
  const server = http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://localhost:${port}`);
    const pathname = url.pathname;

    // ── API: /api/status ──────────────────────────────────────────
    if (pathname === '/api/status' && req.method === 'GET') {
      try {
        const [account, playback, playlistTracks] = await Promise.all([
          player.getAccountInfo(),
          player.getDeviceAndPlaybackState(),
          player.getPlaylistTracks(),
        ]);

        const status = {
          account,
          playback: {
            ...playback,
            currentPlaylistUrl: player.config.playlists?.[player.currentPlaylistIndex] || null,
            playlistIndex: player.currentPlaylistIndex,
            totalPlaylists: player.config.playlists?.length || 0,
          },
          playlistTracks,
          config: player.config,
          stats: {
            uptimeSeconds: Math.floor((Date.now() - player.startTime) / 1000),
            skipsThisHour: player.skipsThisHour,
            isYielding: player.isYielding,
            isWatchdogActive: !!watchdog.interval,
          },
          serverTime: new Date().toISOString(),
        };

        sendJson(res, 200, status);
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
      return;
    }

    // ── API: /api/config ──────────────────────────────────────────
    if (pathname === '/api/config' && req.method === 'GET') {
      sendJson(res, 200, player.config);
      return;
    }

    if (pathname === '/api/config' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const updatedConfig = { ...player.config, ...body };

        // Save to disk
        const saved = saveConfig(updatedConfig);
        if (saved) {
          // Update live instances
          player.config = updatedConfig;
          watchdog.config = updatedConfig;
          player.scheduleRotation(); // Reschedule if rotation interval changed

          console.log('[webui] config updated via WebUI:', updatedConfig);
          sendJson(res, 200, { success: true, config: updatedConfig });
        } else {
          sendJson(res, 500, { error: 'Failed to write config file to disk' });
        }
      } catch (err) {
        sendJson(res, 400, { error: err.message });
      }
      return;
    }

    // ── API: /api/action ──────────────────────────────────────────
    if (pathname === '/api/action' && req.method === 'POST') {
      try {
        const { action, payload } = await parseBody(req);
        console.log(`[webui] action received: ${action}`, payload || '');

        switch (action) {
          case 'play':
            await player.resume();
            break;
          case 'pause':
            await player.pause();
            break;
          case 'skip':
            await player.skipTrack();
            break;
          case 'previous':
            await player.previousTrack();
            break;
          case 'takeover':
            await player.takeOver();
            break;
          case 'rotate':
            await player.rotatePlaylist();
            break;
          case 'restart':
            await player.fullRestart();
            break;
          case 'play_url':
          case 'play_playlist':
            if (payload && payload.url) {
              await player.playUrl(payload.url);
            }
            break;
          case 'play_track':
            if (payload && payload.index) {
              await player.playTrackIndex(parseInt(payload.index, 10));
            }
            break;
          case 'resume_farm':
            player.userControlled = false;
            await player.rotatePlaylist();
            break;
          default:
            sendJson(res, 400, { error: `Unknown action: ${action}` });
            return;
        }

        sendJson(res, 200, { success: true, action });
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
      return;
    }

    // ── Static Files: / (index.html, styles.css, app.js) ─────────
    let filePath = path.join(WEBUI_DIR, pathname === '/' ? 'index.html' : pathname);
    filePath = path.normalize(filePath);

    // Security: prevent directory traversal
    if (!filePath.startsWith(WEBUI_DIR)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    fs.stat(filePath, (err, stats) => {
      if (err || !stats.isFile()) {
        // Fallback to index.html for SPA routing if needed
        const indexPath = path.join(WEBUI_DIR, 'index.html');
        if (fs.existsSync(indexPath)) {
          serveFile(res, indexPath);
        } else {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('WebUI files not found');
        }
        return;
      }
      serveFile(res, filePath);
    });
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`[webui] 🚀 SpotiFarms Dashboard running at http://localhost:${port}`);
  });

  return server;
}

function serveFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(500);
      res.end('Internal Server Error');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

function sendJson(res, statusCode, obj) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error('Invalid JSON payload'));
      }
    });
    req.on('error', reject);
  });
}

module.exports = { startServer };
