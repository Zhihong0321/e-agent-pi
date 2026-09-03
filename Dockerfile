FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
  PYTHONUNBUFFERED=1 \
  PYTHONDONTWRITEBYTECODE=1 \
  PLAYWRIGHT_BROWSERS_PATH=/opt/playwright \
  SCRAPLING_BIN=/opt/scrapling/bin/scrapling \
  PATH="/opt/scrapling/bin:${PATH}"

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    curl \
    python3 \
    python3-venv \
    python3-pip \
    unzip \
    poppler-utils \
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

# Antigravity CLI (AGY) Linux x86_64 installation
RUN (curl -fsSL https://antigravity.google/cli/install.sh | bash -s -- -d /usr/local/bin \
    || (mkdir -p /tmp/agy && curl -fsSL https://storage.googleapis.com/antigravity-public/antigravity-cli/1.1.25-6680093607723008/linux-x64/cli_linux_x64.tar.gz | tar -xz -C /tmp/agy && cp /tmp/agy/antigravity /usr/local/bin/agy && rm -rf /tmp/agy)) \
  && chmod +x /usr/local/bin/agy \
  && /usr/local/bin/agy --version

WORKDIR /app

COPY package.json package-lock.json ./
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080
CMD ["node", "server/index.mjs"]
