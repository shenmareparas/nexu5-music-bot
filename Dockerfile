FROM oven/bun:latest

# Install ffmpeg and python3 (required by yt-dlp)
RUN apt-get update && apt-get install -y ffmpeg python3 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency manifests
COPY package.json bun.lock ./

# Install dependencies
RUN bun install --frozen-lockfile

# Copy the application source code
COPY . .

# Start the bot
CMD ["bun", "index.js"]
