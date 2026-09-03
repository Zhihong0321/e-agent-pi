FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
  PYTHONUNBUFFERED=1 \
  PYTHONDONTWRITEBYTECODE=1 \
  PLAYWRIGHT_BROWSERS_PATH=/opt/playwright \
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=0 \
  SCRAPLING_BIN=/opt/scrapling/bin/scrapling \
  PATH="/opt/scrapling/bin:${PATH}"

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    python3 \
    python3-venv \
    python3-pip \
    unzip \
  && rm -rf /var/lib/apt/lists/*

# Scrapling CLI + Chromium (HTTP fetchers, headless, stealth). Layer is independent of app copy.
RUN python3 -m venv /opt/scrapling \
  && /opt/scrapling/bin/pip install --no-cache-dir --upgrade pip \
  && /opt/scrapling/bin/pip install --no-cache-dir "scrapling[all]>=0.4.15" \
  && apt-get update \
  && (/opt/scrapling/bin/python -m playwright install-deps chromium \
      || /opt/scrapling/bin/python -m patchright install-deps chromium \
      || true) \
  && (/opt/scrapling/bin/python -m playwright install chromium || true) \
  && (/opt/scrapling/bin/python -m patchright install chromium || true) \
  && /opt/scrapling/bin/scrapling install --force \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080
CMD ["node", "server/index.mjs"]
