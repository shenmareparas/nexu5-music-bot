FROM oven/bun:latest

# Install ffmpeg, python3 (required by yt-dlp), and nodejs (required by yt-dlp's JS challenge solver)
RUN apt-get update && apt-get install -y ffmpeg python3 nodejs && rm -rf /var/lib/apt/lists/*

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
