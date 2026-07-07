# Developer Agent Guide: NEXU5 Music Bot

This document provides a guide for AI developer agents and engineers working on this repository. It outlines the architecture, constraints, runtime configuration, and common operations.

## Core Stack

- **Runtime**: [Bun](https://bun.sh/) (do not use Node.js or npm commands).
- **Discord API Library**: `discord.js` v14.
- **Voice Library**: `@discordjs/voice` with `@snazzah/davey` for Discord DAVE end-to-end voice encryption support.
- **Audio Downloader / Metadata**: `yt-dlp` (spawning child processes). Used for **all** YouTube operations: search, video metadata, playlist enumeration, and audio streaming. `play-dl` is retained only for Spotify URL parsing (`play.spotify()`).
- **Audio Transcoder**: `ffmpeg` (via `ffmpeg-static` or system path).
  - *Optimization Note*: The `-re` (real-time) input flag has been removed from `ffmpeg` arguments. This allows `ffmpeg` to download and transcode audio as fast as possible, buffering the stream to prevent premature cutoffs and `Idle` state triggers caused by network jitter.
  - *`player_skip` Scope*: `--extractor-args youtube:player_skip=webpage,configs` is passed **only** to `ytdlpSearch` and `ytdlpVideoInfo` (metadata-only calls). It must **not** be passed to the streaming `yt-dlp` invocation in `playNext()` — yt-dlp needs to fetch the player configs to resolve the signed audio stream URL. Applying it to streaming silently breaks direct YouTube URL playback while text-search continues to work (search only dumps flat JSON, no stream URL needed).

## Architecture & Code Map

### 1. [index.js](file:///Users/parasshenmare/Developer/other_projects/nexu5-music-bot/index.js)
- **Role**: Client initialization, slash command deployment, gateway interaction dispatch.
- **Slash Commands & Aliases**: Configured with a guild-specific fast deployment path (if `DEV_GUILD_ID` is present in `.env`) or global registration fallback.
  - Registers alias commands (`/chup`, `/nikal`, `/bhok`, `/suna`, `/pehle`) mapped to the same core handlers as their standard counterparts.
  - Automatically clears global application commands when `DEV_GUILD_ID` is defined to prevent command duplication in the Discord UI.
- **Buttons Dispatch**: Routes interaction events (e.g., `skip`, `pause_resume`, `stop`, `queue_list`) to the corresponding `MusicPlayer` guild instance.
- **Select Menu Dispatch**: Routes interaction events (specifically for `/find` search results) to `musicPlayer.handleSelectMenu`.

### 2. [musicPlayer.js](file:///Users/parasshenmare/Developer/other_projects/nexu5-music-bot/musicPlayer.js)
- **Role**: State manager for a guild's voice connection, audio playback queue, active child processes, temporary Discord message instances, and search states.
- **Key Concepts**:
  - **Ogg Opus Streaming**: Streams are transcoded directly into Ogg Opus (`-c:a libopus -f opus`) by `ffmpeg` and played as `StreamType.OggOpus`. This avoids JS-based transcoding performance drops.
  - **Error Handling / Pipes**: 
    - Ensure both `ytDlpProcess.stdout` and `ffmpegProcess.stdin` have `.on('error', ...)` attached to avoid crashing the Bun runtime on pipe termination (`EPIPE`).
    - Listen to `'error'` events on `this.connection` (VoiceConnection) to prevent uncaught network exceptions (e.g. `EHOSTUNREACH: host is unreachable`) from bubbling up.
  - **Connection Lifecycle & Moving**: All voice connection lifecycle events and listeners (including debugging and disconnection handlers) are managed in a unified `connect()` method. Movement to a different voice channel (e.g., in `handleMove`) reuses `connect()` to keep event registration consistent.
  - **DAVE Handshake / Disconnected Race**: The `VoiceConnectionStatus.Disconnected` handler races against `Signalling`, `Connecting`, **and `Ready`**. This is critical — the DAVE E2E encryption handshake (`@snazzah/davey`) briefly fires `Disconnected` during normal connection setup before settling into `Ready`. Without racing `Ready`, the 5-second timeout fires and incorrectly destroys the queue. Do **not** remove `Ready` from this race.
  - **Stderr Filtering**: Filters out `yt-dlp`'s Bun deprecation warning (`bun support has been deprecated`) from standard logging to keep the console clean.
  - **Self-Cleaning / Session Messages**: Every interactive response or Now Playing banner is registered in `sessionMessages` or `nowPlayingMessage`. Upon disconnection, track completion, or skip, these messages are deleted.
  - **Set-based Deletion**: The `destroy()` method deduplicates deleted messages using a `Set` and suppresses code `10008` (Unknown Message) errors in case messages were deleted manually by users.
  - **Auto-Leave Guard**: A 15-second empty voice channel check is registered via `emptyTimeout` when voice channel members list drops to just the bot.
  - **URL Normalization**: Normalizes YouTube Music URLs (`music.youtube.com`) to standard YouTube URLs in `handlePlay` and strips query parameters that interfere with parsing.
  - **Asynchronous Playlist Loading (`loadYtPlaylist`)**: Enumerates playlists (including YouTube Mixes and Radios) via `yt-dlp --flat-playlist`. Queues the first track synchronously so music starts playing immediately, then loads all remaining tracks asynchronously in the background.
  - **yt-dlp Search & Metadata Helpers**: Two module-level functions replace all `play-dl` YouTube HTTP calls to prevent 429 rate-limit errors on cloud IPs:
    - `ytdlpSearch(query, limit)` — runs `yt-dlp ytsearch<N>:<query> --flat-playlist --dump-json` and returns `[{ title, url, duration }]`. Used by `/play` (text search), `/find`, and Spotify track lookups.
    - `ytdlpVideoInfo(url)` — runs `yt-dlp <url> --dump-json --no-playlist` and returns `{ title, url, duration }`. Used by `/play` when given a direct YouTube video URL.
    - Both helpers automatically pass `--extractor-args youtube:player_skip=webpage,configs` and `--cookies cookies.txt` (if present).
  - **URL Type Detection (no-network)**: `handlePlay` no longer calls `play.validate()` (which made a YouTube HTTP request). Instead, query type (YouTube video, playlist, Spotify, plain search) is detected locally by parsing the URL hostname and path.
  - **Ephemeral Search Flow (`handleFind` / `handleSelectMenu`)**: Uses `ytdlpSearch` to get up to 5 YouTube results. Search embeds and select menus are ephemeral and restricted to the requesting user. Pending search results are stored in `pendingSearchResults` keyed by the user's ID and expire after 60 seconds. Supports multi-selection, allowing users to queue multiple songs from a single search.
  - **Ephemeral Messaging**: Ephemeral messages are sent using `MessageFlags.Ephemeral` in `interaction.reply` or `interaction.followUp`.

## Interaction Reply Patterns

All handler functions that need the reply message object (e.g. to push it into `sessionMessages` for later deletion) use the modern `withResponse: true` pattern introduced in discord.js v14:

```js
// ✅ Correct — withResponse: true
const { resource: { message: msg } } = await interaction.reply({ content: '...', withResponse: true });
queue.sessionMessages.push(msg);

// ❌ Deprecated — do NOT use fetchReply: true
const msg = await interaction.reply({ content: '...', fetchReply: true });
```

- All handler functions that use `withResponse: true` must be declared `async`.
- Ephemeral-only replies (no message object needed) continue to use `flags: MessageFlags.Ephemeral` without `withResponse`.

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
- `YOUTUBE_COOKIES`: (Optional) Netscape format cookies content for YouTube authentication to bypass restriction/age blocks.
- `YTDLP_PATH`: (Optional) Override path to the `yt-dlp` executable.

## Bypassing YouTube Rate Limits (HTTP 429 / 403)
- All YouTube interactions — **search, video metadata, playlist enumeration, and audio streaming** — are routed exclusively through `yt-dlp`. This is intentional: `play-dl`'s `play.search()`, `play.video_info()`, and `play.validate()` make direct HTTP requests to YouTube's internal APIs, which get rate-limited (429) on cloud-hosted IPs.
- Every `yt-dlp` invocation includes `--extractor-args "youtube:player_skip=webpage,configs"` to skip the HTML webpage scrape and go straight to the stream config API.
- Cookies (`cookies.txt` / `YOUTUBE_COOKIES` env var) are passed to all `yt-dlp` calls for authenticated access.
- `play-dl` is kept as a dependency **only** for Spotify URL parsing via `play.spotify()`. Do not add new `play.search`, `play.video_info`, or `play.validate` calls — use `ytdlpSearch` and `ytdlpVideoInfo` instead.
- **Preventing Cookie Expiration**: Since YouTube rotates token sessions when you actively browse the site on the same profile, cookies exported from your main profile expire almost daily. To fix this:
  1. Open a new **Incognito/Private Window**.
  2. Log into YouTube.
  3. Export cookies using an extension (like "Get cookies.txt LOCALLY") and close the window immediately without browsing.
  4. Use these cookies. They will remain valid for months as long as the incognito session is left untouched.

## Known Bugs & Fixes

### `/join` causes immediate disconnect (DAVE handshake race condition)
- **Symptom**: Bot joins the voice channel and immediately leaves; logs show `[connection] Reconnect failed, destroying connection` right after `[connection] State: Ready`.
- **Root Cause**: The DAVE E2E encryption handshake (`@snazzah/davey`) briefly fires `VoiceConnectionStatus.Disconnected` as part of normal protocol negotiation, before the connection fully settles into `Ready`. The old `Disconnected` handler only raced `Signalling` and `Connecting` — both already past — so the 5-second timeout expired and `destroy()` was incorrectly called.
- **Fix**: Added `entersState(this.connection, VoiceConnectionStatus.Ready, 5000)` to the `Promise.race()` inside the `Disconnected` handler in `connect()`. If the connection reaches `Ready`, the disconnect is treated as a harmless transient blip.

### Direct YouTube URL (`/play <url>`) does not play; text search works fine
- **Symptom**: Pasting a YouTube link into `/play` produces no audio or silently fails; searching by song name plays correctly.
- **Root Cause**: The streaming `yt-dlp` invocation in `playNext()` included `--extractor-args youtube:player_skip=webpage,configs`. This flag skips the player config fetch that yt-dlp needs to resolve the signed, time-limited audio stream URL. Text search is unaffected because `ytdlpSearch` only dumps flat JSON metadata — no stream URL is resolved at that stage.
- **Fix**: Removed `--extractor-args youtube:player_skip=webpage,configs` (and the unused `--remote-components` / `--js-runtimes` flags) from the streaming invocation in `playNext()`. The `player_skip` flag is still correctly applied in `ytdlpSearch` and `ytdlpVideoInfo` where only metadata is fetched.
