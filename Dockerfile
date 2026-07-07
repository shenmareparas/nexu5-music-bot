FROM oven/bun:latest

# Install ffmpeg, python3, pip, and nodejs (required for yt-dlp and its JS challenge solver)
RUN apt-get update && apt-get install -y ffmpeg python3 python3-pip nodejs && rm -rf /var/lib/apt/lists/*

# Ensure "node" is available as a command pointing to nodejs (needed by yt-dlp's JS challenge solver)
RUN ln -sf /usr/bin/nodejs /usr/bin/node

# Install yt-dlp[default] via pip to ensure the JS n-challenge solver (EJS) scripts are present
RUN pip3 install --no-cache-dir --break-system-packages "yt-dlp[default]"

WORKDIR /app

# Copy dependency manifests
COPY package.json bun.lock ./
COPY patches/ ./patches/

# Install dependencies
RUN bun install --frozen-lockfile

# Copy the application source code
COPY . .

# Start the bot
CMD ["bun", "index.js"]
