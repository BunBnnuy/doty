FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends chromium xvfb openbox xdotool ffmpeg fonts-dejavu ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1001 browser
WORKDIR /app
COPY worker.mjs egress.mjs images.mjs ./
COPY browser-policy.json /etc/chromium/policies/managed/doty.json
RUN mkdir -p /home/browser/profile /home/browser/.cache /home/browser/.config /home/browser/.local && chown -R browser:browser /home/browser
USER browser
ENV HOME=/home/browser DISPLAY=:99
CMD ["node", "worker.mjs"]
