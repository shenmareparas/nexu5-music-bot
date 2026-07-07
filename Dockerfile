FROM oven/bun:latest

# Install ffmpeg, python3, pip, nodejs, curl, and unzip (required for yt-dlp and its JS challenge solver)
RUN apt-get update && apt-get install -y ffmpeg python3 python3-pip nodejs curl unzip && rm -rf /var/lib/apt/lists/*

# Install Deno (yt-dlp's preferred and most reliable JS runtime for challenge solving)
RUN curl -fsSL https://deno.land/install.sh | sh && mv /root/.deno/bin/deno /usr/local/bin/deno

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
