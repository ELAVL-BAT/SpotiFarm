# ================================================================
# SpotiFarms Dockerfile
# Headless Spotify Web Player — runs 24/7 as a Connect device
# Stack: Xvfb + PulseAudio + Chromium (Playwright) + Node.js
# ================================================================

FROM node:20-slim AS base

# prevent interactive prompts during apt
ENV DEBIAN_FRONTEND=noninteractive

# ─── System deps ────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    # virtual display
    xvfb \
    # audio
    pulseaudio \
    # vnc for debugging
    x11vnc \
    novnc \
    websockify \
    # process manager
    supervisor \
    # Playwright / Chromium deps (the full set — Chromium is picky)
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    libatspi2.0-0 \
    libwayland-client0 \
    # fonts — Spotify renders text, no fonts = broken UI
    fonts-liberation \
    fonts-noto-color-emoji \
    fonts-dejavu-core \
    # utils
    dbus \
    procps \
    curl \
    && rm -rf /var/lib/apt/lists/*

# ─── PulseAudio config ─────────────────────────────────────────────
RUN mkdir -p /root/.config/pulse && \
    echo "default-server = unix:/tmp/pulse-socket" > /root/.config/pulse/client.conf && \
    echo "autospawn = no" >> /root/.config/pulse/client.conf

# ─── App setup ──────────────────────────────────────────────────────
WORKDIR /app

COPY package.json ./
RUN npm install --production

# install Playwright's bundled Chromium + deps
RUN npx playwright install chromium && \
    npx playwright install-deps chromium

COPY src/ ./src/
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf

# ─── Data directories ──────────────────────────────────────────────
RUN mkdir -p /data/chrome-profile /config

# ─── Expose ports ──────────────────────────────────────────────────
# 3000 = SpotiFarms WebUI Dashboard
# 6080 = noVNC web UI
# 5900 = raw VNC
EXPOSE 3000 6080 5900

# ─── Environment ───────────────────────────────────────────────────
ENV DISPLAY=:99
ENV PULSE_SERVER=unix:/tmp/pulse-socket
ENV NODE_ENV=production
ENV CONFIG_PATH=/config/config.json
ENV PROFILE_DIR=/data/chrome-profile

# ─── Launch ────────────────────────────────────────────────────────
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
