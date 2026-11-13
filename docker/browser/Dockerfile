# Headed Playwright Chromium + Xvfb + x11vnc + noVNC/websockify.
# The Playwright npm version below MUST match the base image tag and src/docker.ts PLAYWRIGHT_VERSION.
FROM mcr.microsoft.com/playwright:v1.65.0-noble

USER root
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      xvfb x11vnc novnc websockify procps \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 10001 ctf \
 && useradd -u 10001 -g 10001 -m -d /home/ctf -s /bin/bash ctf \
 && mkdir -p /home/ctf/profile /home/ctf/downloads \
 && chown -R 10001:10001 /home/ctf

WORKDIR /opt/ctf-driver
COPY package.json driver.mjs entrypoint.sh ./
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --omit=dev --no-audit --no-fund --save-exact \
 && test "$(node -p 'require("playwright/package.json").version')" = "1.65.0" \
 && chmod 0755 entrypoint.sh \
 && chmod 0644 driver.mjs package.json

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    DISPLAY=:99 \
    HOME=/home/ctf

USER 10001:10001
EXPOSE 6080
ENTRYPOINT ["/opt/ctf-driver/entrypoint.sh"]
