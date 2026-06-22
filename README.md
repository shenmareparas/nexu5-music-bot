# NEXU5 Music

A clean, modern, and performant Discord Music Bot utilizing **discord.js v14**, **@discordjs/voice**, and **play-dl**, running on the **Bun** runtime. Includes automatic static `ffmpeg` fallback.

## Features

- 🎧 **Rich Button Controls**: Skip, Pause/Resume, Stop, and Queue buttons automatically attached to the Now Playing message.
- 🧼 **Clean Chat Mode**: Automatically deletes command feedback and bot messages upon playback completion or disconnection to keep channels clutter-free.
- ⏱️ **Auto-Leave Guard**: Automatically disconnects from the voice channel when it has been empty for more than 15 seconds.
- ⚡ **Ultra-low Latency Audio Pipeline**: Leverages native **Ogg Opus** encoding within `ffmpeg` (`-c:a libopus -f opus`) to ensure high-fidelity, stutter-free playback without speed fluctuations.
- 🔒 **DAVE Protocol Ready**: Preconfigured with `@snazzah/davey` to support Discord's E2E voice encryption protocols.

## Prerequisites

- [Bun](https://bun.sh/) (v1.0.0 or higher)
- A Discord Developer Account

## Getting Started

### 1. Create a Discord Bot Application
1. Go to the [Discord Developer Portal](https://discord.com/developers/applications).
2. Click **New Application** and give it a name.
3. Go to the **Bot** tab on the left sidebar:
   - Click **Add Bot**.
   - Scroll down to **Privileged Gateway Intents** and enable:
     - **Guild Members Intent** (Optional, but recommended)
     - **Message Content Intent** (Required)
   - Click **Reset Token** to copy your bot's token. Keep this secret!
4. Go to the **OAuth2** tab:
   - Copy the **Client ID** (Application ID) from the **General Information** page.
5. Generate the invite URL:
   - Go to **OAuth2** -> **URL Generator**.
   - Under **Scopes**, select `bot` and `applications.commands`.
   - Under **Bot Permissions**, select:
     - *General Permissions*: `Read Messages/View Channels`
     - *Text Permissions*: `Send Messages`, `Embed Links`, `Read Message History`
     - *Voice Permissions*: `Connect`, `Speak`
   - Copy the generated URL at the bottom and open it in a browser to invite the bot to your Discord server.

### 2. Configure Environment Variables
Copy `.env.example` to `.env` and fill in the values:
```env
DISCORD_TOKEN=your_bot_token_here
CLIENT_ID=your_client_id_here
DEV_GUILD_ID=your_test_server_id_here  # Optional: For instant slash command updates in your dev server
```

### 3. Installation
Install the dependencies using Bun:
```bash
bun install
```

### 4. Running the Bot
Start the bot application:
```bash
bun start
```

## Slash Commands

- `/play <query>` (or `/suna`) - Play a song (from URL or search terms).
- `/pause` (or `/chup`) - Pause music.
- `/resume` (or `/bhok`) - Resume music.
- `/leave` (or `/nikal`) - Leave voice channel and clear queue.
- `/skip` - Skip current song.
- `/stop` - Stop music, clear queue, and leave.
- `/queue` - Show current queue.
- `/join` - Join your current voice channel.

## Deploying to Railway

This bot is fully configured for deployment on [Railway](https://railway.app) using Nixpacks.

### Steps to Deploy

1. **Fork or Upload the Repository**: Push this repository to your GitHub account.
2. **Create a Railway Project**:
   - Go to the Railway dashboard and click **New Project**.
   - Select **Deploy from GitHub repo** and choose this repository.
3. **Configure Environment Variables**:
   Go to the **Variables** tab of the service and add:
   - `DISCORD_TOKEN`: Your Discord Bot Token.
   - `CLIENT_ID`: Your Discord Bot Application/Client ID.
4. **Deploy**:
   Railway will automatically detect the `nixpacks.toml` file, set up the Bun runtime environment, install system dependencies (`ffmpeg`, `yt-dlp`, and `python3`), and start the bot using the `bun start` command.

