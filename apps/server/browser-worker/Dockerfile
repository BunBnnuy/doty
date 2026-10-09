FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends chromium xvfb openbox xdotool ffmpeg fonts-dejavu ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1001 browser
WORKDIR /app
COPY worker.mjs egress.mjs ./
RUN mkdir -p /home/browser/profile /home/browser/.cache /home/browser/.config && chown -R browser:browser /home/browser
USER browser
ENV HOME=/home/browser DISPLAY=:99
CMD ["node", "worker.mjs"]
