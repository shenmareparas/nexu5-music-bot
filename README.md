# NEXU5 Music

A clean, modern, and performant Discord Music Bot utilizing **discord.js v14**, **@discordjs/voice**, and **yt-dlp**, running on the **Bun** runtime. Includes automatic static `ffmpeg` fallback.

## Features

- 🎧 **Rich Button Controls**: Skip, Pause/Resume, Stop, and Queue buttons automatically attached to the Now Playing message.
- 🧼 **Clean Chat Mode**: Automatically deletes command feedback and bot messages upon playback completion or disconnection to keep channels clutter-free.
- ⏱️ **Auto-Leave Guard**: Automatically disconnects from the voice channel when it has been empty for more than 15 seconds.
- ⚡ **Ultra-low Latency Audio Pipeline**: Leverages native **Ogg Opus** encoding within `ffmpeg` (`-c:a libopus -f opus`) to ensure high-fidelity, stutter-free playback without speed fluctuations.
- 🔍 **Interactive Song Search**: Use `/find` to search YouTube and select one or more songs to queue via a user-scoped, interactive dropdown select menu.
- 🗂️ **Instant Playlist Loading**: Supports YouTube playlists, mixes, and radios. Automatically begins playing the first song instantly while resolving and loading the rest in the background.
- 🔒 **DAVE Protocol Ready**: Preconfigured with `@snazzah/davey` to support Discord's E2E voice encryption protocols. The `Disconnected` handler correctly races `Ready` state to avoid false-positive destroy calls triggered by the DAVE handshake.
- 🛡️ **Fault-Tolerant Networking**: Resilient handling of UDP socket and voice connection error events (such as `EHOSTUNREACH`) to prevent uncaught exceptions and process crashes.
- ⚙️ **Robust Process Spawning & Binary Management**: Automatically downloads the latest `yt-dlp` executable on startup with built-in retry logic (to handle transient network failures) and safeguards all child process `spawn()` executions to prevent unhandled exceptions.

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
- `/playtop <query>` (or `/pehle`) - Add a song/playlist to the top of the queue.
- `/find <query>` - Search YouTube for up to 5 matches and select one or more tracks using a dropdown select menu.
- `/pause` (or `/chup`) - Pause music.
- `/resume` (or `/bhok`) - Resume music.
- `/leave` (or `/nikal`) - Leave voice channel and clear queue.
- `/skip` - Skip current song.
- `/stop` - Stop music, clear queue, and leave.
- `/queue` - Show current queue.
- `/join` - Join your current voice channel.
- `/move` - Move the bot to your current voice channel.
- `/controls` - Show interactive buttons to control playback in the channel.

## Deploying to Railway

This bot is fully configured for deployment on [Railway](https://railway.app) using the provided `Dockerfile`.

### Steps to Deploy

1. **Fork or Upload the Repository**: Push this repository to your GitHub account.
2. **Create a Railway Project**:
   - Go to the Railway dashboard and click **New Project**.
   - Select **Deploy from GitHub repo** and choose this repository.
3. **Configure Environment Variables**:
   Go to the **Variables** tab of the service and add:
   - `DISCORD_TOKEN`: Your Discord Bot Token.
   - `CLIENT_ID`: Your Discord Bot Application/Client ID.
   - `YOUTUBE_COOKIES`: (Optional but highly recommended) Your Netscape format cookies file content to authenticate YouTube requests.
4. **Deploy**:
   Railway will automatically build the container using the `Dockerfile`, install system dependencies (`ffmpeg` and `python3`), download/update `yt-dlp`, and start the bot using the `bun start` command.

> [!TIP]
> **Preventing Cookie Expiration**:
> Cookies expire quickly (often daily) because YouTube rotates tokens whenever you actively browse on the same profile. To get long-lasting cookies (stable for months):
> 1. Open a new **Incognito/Private Window** in your browser.
> 2. Log into YouTube.
> 3. Export the cookies in Netscape format (using an extension like "Get cookies.txt LOCALLY").
> 4. **Close the incognito window immediately** without logging out or browsing further. Do not use this specific session for casual browsing.
> 5. Paste these cookies into your environment or `cookies.txt`.

> [!NOTE]
> All YouTube interactions — including **search, metadata lookups, and audio streaming** — are routed through `yt-dlp`. `--extractor-args "youtube:player_skip=webpage,configs"` is applied **only** to `ytdlpSearch` (flat-playlist search) where no stream URL resolution is needed. For `ytdlpVideoInfo` and the streaming invocation in `playNext()`, the bot forces `--extractor-args youtube:player_client=ios,web,android;formats=missing_pot` to bypass GVS PO Token enforcement. To keep playback reliable, these calls run **without** cookies by default so that the fast `ios` client is used. If a playback or lookup fails (due to age-restrictions or bot-blocking), the bot automatically retries **with** cookies; on retry, it skips `ios` and falls back to `web`/`android` using the container's Node.js runtime and pip-installed `yt-dlp` EJS scripts to solve the JavaScript n-challenge. `play-dl` is retained only for Spotify URL parsing (`play.spotify()`).


