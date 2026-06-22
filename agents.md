# Developer Agent Guide: NEXU5 Music Bot

This document provides a guide for AI developer agents and engineers working on this repository. It outlines the architecture, constraints, runtime configuration, and common operations.

## Core Stack

- **Runtime**: [Bun](https://bun.sh/) (do not use Node.js or npm commands).
- **Discord API Library**: `discord.js` v14.
- **Voice Library**: `@discordjs/voice` with `@snazzah/davey` for Discord DAVE end-to-end voice encryption support.
- **Audio Downloader**: `play-dl` + `yt-dlp` (spawning yt-dlp child processes).
- **Audio Transcoder**: `ffmpeg` (via `ffmpeg-static` or system path).
  - *Optimization Note*: The `-re` (real-time) input flag has been removed from `ffmpeg` arguments. This allows `ffmpeg` to download and transcode audio as fast as possible, buffering the stream to prevent premature cutoffs and `Idle` state triggers caused by network jitter.

## Architecture & Code Map

### 1. [index.js](file:///Users/parasshenmare/Developer/other_projects/discord-music-bot/index.js)
- **Role**: Client initialization, slash command deployment, gateway interaction dispatch.
- **Slash Commands & Aliases**: Configured with a guild-specific fast deployment path (if `DEV_GUILD_ID` is present in `.env`) or global registration fallback.
  - Registers alias commands (`/chup`, `/nikal`, `/bhok`, `/suna`) mapped to the same core handlers as their standard counterparts.
  - Automatically clears global application commands when `DEV_GUILD_ID` is defined to prevent command duplication in the Discord UI.
- **Buttons Dispatch**: Routes interaction events (e.g., `skip`, `pause_resume`, `stop`, `queue_list`) to the corresponding `MusicPlayer` guild instance.

### 2. [musicPlayer.js](file:///Users/parasshenmare/Developer/other_projects/discord-music-bot/musicPlayer.js)
- **Role**: State manager for a guild's voice connection, audio playback queue, active child processes, and temporary Discord message instances.
- **Key Concepts**:
  - **Ogg Opus Streaming**: Streams are transcoded directly into Ogg Opus (`-c:a libopus -f opus`) by `ffmpeg` and played as `StreamType.OggOpus`. This avoids JS-based transcoding performance drops.
  - **Error Handling / Pipes**: Ensure both `ytDlpProcess.stdout` and `ffmpegProcess.stdin` have `.on('error', ...)` attached to avoid crashing the Bun runtime on pipe termination (`EPIPE`).
  - **Stderr Filtering**: Filters out `yt-dlp`'s Bun deprecation warning (`bun support has been deprecated`) from standard logging to keep the console clean.
  - **Self-Cleaning / Session Messages**: Every interactive response or Now Playing banner is registered in `sessionMessages` or `nowPlayingMessage`. Upon disconnection, track completion, or skip, these messages are deleted.
  - **Set-based Deletion**: The `destroy()` method deduplicates deleted messages using a `Set` and suppresses code `10008` (Unknown Message) errors in case messages were deleted manually by users.
  - **Auto-Leave Guard**: A 15-second empty voice channel check is registered via `emptyTimeout` when voice channel members list drops to just the bot.

## Commands for Agents

### Setup & Installation
```bash
bun install
```

### Starting the Bot
```bash
bun start
```

## Environment Variables (.env)
- `DISCORD_TOKEN`: Discord Bot Token.
- `CLIENT_ID`: Discord Client/Application ID.
- `DEV_GUILD_ID`: (Optional) ID of a server to deploy slash commands to instantly during development.
