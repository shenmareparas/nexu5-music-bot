# Developer Agent Guide: NEXU5 Music Bot

This document provides a guide for AI developer agents and engineers working on this repository. It outlines the architecture, constraints, runtime configuration, and common operations.

## Core Stack

- **Runtime**: [Bun](https://bun.sh/) (do not use Node.js or npm commands).
- **Discord API Library**: `discord.js` v14.
- **Voice Library**: `@discordjs/voice` with `@snazzah/davey` for Discord DAVE end-to-end voice encryption support.
- **Audio Downloader / Metadata**: `yt-dlp` (spawning child processes). Used for **all** YouTube operations: search, video metadata, playlist enumeration, and audio streaming. `play-dl` is retained only for Spotify URL parsing (`play.spotify()`).
- **Audio Transcoder**: `ffmpeg` (via `ffmpeg-static` or system path).
  - *Optimization Note*: The `-re` (real-time) input flag has been removed from `ffmpeg` arguments. This allows `ffmpeg` to download and transcode audio as fast as possible, buffering the stream to prevent premature cutoffs and `Idle` state triggers caused by network jitter.
  - *`player_skip` Scope*: `--extractor-args youtube:player_skip=webpage,configs` is passed **only** to `ytdlpSearch` (flat-playlist/metadata-only search). It must **not** be passed to `ytdlpVideoInfo` (which uses `--dump-json` and resolves the formats list — requiring the player config), nor to the streaming invocation in `playNext()`. Applying it to either of those calls causes yt-dlp to exit non-zero with empty stdout, resulting in a silent `null` / "Could not fetch info" failure for direct YouTube URL playback.

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
    - `ytdlpSearch(query, limit)` — runs `yt-dlp ytsearch<N>:<query> --flat-playlist --dump-json` and returns `[{ title, url, duration }]`. Used by `/play` (text search), `/find`, and Spotify track lookups. Passes `--extractor-args youtube:player_skip=webpage,configs` (safe here — only flat JSON is needed, no stream URL is resolved). Automatically passes `--cookies cookies.txt` (if present).
    - `ytdlpVideoInfo(url)` — runs `yt-dlp <url> --dump-json --no-playlist` and returns `{ title, url, duration }`. Used by `/play` when given a direct YouTube video URL. Does **not** pass `player_skip` but forces `youtube:player_client=ios,web,mweb,android,tvhtml5;formats=missing_pot` to bypass GVS PO Token enforcement. It automatically retries **with** cookies if the initial attempt fails (solving the n-challenge using the container's Deno/Node.js runtimes). Also collects stderr and logs it on non-zero exit for debuggability.
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
- `--extractor-args "youtube:player_skip=webpage,configs"` is passed **only to `ytdlpSearch`** (flat-playlist search). It is intentionally omitted from `ytdlpVideoInfo` and `playNext()`, which instead force the player client fallback list (`youtube:player_client=ios,web,mweb,android,tvhtml5;formats=missing_pot`) to bypass GVS PO Token enforcement.
- **Self-Healing Cookie Retries**: By default, `ytdlpVideoInfo` and `playNext()` execute `yt-dlp` **without** cookies. This allows the fast, OAuth-based `ios` client to be utilized (since it doesn't support cookies and is skipped if they are present). If the request fails (e.g. because of age-restriction or bot-blocking challenges), and a local `cookies.txt` is available, the bot automatically retries the command **with** cookies. On retry, the `ios` and `android` clients are skipped (as they do not support cookies), and `yt-dlp` falls back to `web`, `mweb`, or `tvhtml5` using the **Deno** runtime inside the container to solve the JS n-challenge. This bypasses PO Token enforcement on the `web` client while ensuring public videos play instantly and reliably. Flat searches (`ytdlpSearch`) and playlist loading (`loadYtPlaylist`) continue to use cookies by default.
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
- **Fix**: Removed `--extractor-args youtube:player_skip=webpage,configs` (and the unused `--remote-components` / `--js-runtimes` flags) from the streaming invocation in `playNext()`. The `player_skip` flag is correctly applied only in `ytdlpSearch` where only flat metadata is fetched.

### `/play <url>` says "Could not fetch info for" — text search still works
- **Symptom**: `/play <youtube-url>` replies with `❌ Could not fetch info for: <url>`. `/play <song name>` works fine.
- **Root Cause**: `ytdlpVideoInfo` (the helper used for direct URL metadata lookup) was incorrectly passing `--extractor-args youtube:player_skip=webpage,configs`. Unlike `ytdlpSearch` which uses `--flat-playlist` (no stream URL resolution), `ytdlpVideoInfo` uses `--dump-json` which walks the formats list — this requires fetching the player config. With `player_skip` set, yt-dlp exits non-zero, stdout is empty, `JSON.parse` throws, and the function silently returns `null`. Stderr was also not collected, making the failure invisible in logs.
- **Fix**: Removed `player_skip` from `ytdlpVideoInfo`. Added stderr collection and exit-code logging so any future failure surfaces the actual yt-dlp error in the bot console.

### `/play <url>` fails with "n challenge solving failed" / "Requested format is not available"
- **Symptom**: yt-dlp logs show `n challenge solving failed` and `ERROR: Requested format is not available`. Audio never plays.
- **Root Cause**: YouTube's `n` parameter challenge requires a JavaScript runtime (Deno, Node.js) to solve the nsig (throttling signature). In the oven/bun container base, `/usr/bin/node` is a symlink pointing to the Bun binary, which does not support the EJS challenge solver scripts. Furthermore, Node.js versions below v22 are marked `(unsupported)` by modern `yt-dlp` releases, and YouTube enforces PO Tokens on the `web` client.
- **Fix**: Installed **Deno** (the preferred JS engine for `yt-dlp`) in the Dockerfile and configured `yt-dlp` to prioritize Deno. In `playNext` and `ytdlpVideoInfo`, `--js-runtimes` is passed multiple times (`--js-runtimes deno --js-runtimes node:/usr/bin/nodejs`), and fallback clients list is expanded to include `mweb` and `tvhtml5` (which do not enforce PO Tokens), successfully bypassing YouTube's anti-bot restrictions on cloud IPs.

### Bun process crashes with `ENOENT` / `Executable not found in $PATH` on startup/play
- **Symptom**: If the automatic download of the `yt-dlp` binary fails on startup (e.g., due to a `504 Gateway Timeout`), subsequent command execution triggers an uncaught `Executable not found in $PATH` error and crashes the entire bot runtime.
- **Root Cause**: `ensureYtdlp()` did not retry on network failures, and spawning helpers (`ytdlpSearch`, `ytdlpVideoInfo`, `loadYtPlaylist`) lacked try-catch blocks or `.on('error')` listeners to handle missing executables gracefully.
- **Fix**: Added a retry mechanism (up to 3 attempts with a 3-second delay) to `ensureYtdlp()` for downloading the binary. Additionally, wrapped `spawn()` commands in try-catch blocks and attached `.on('error', ...)` handlers to intercept spawn failures and prevent uncaught runtime exceptions.

### Local standalone binary overrides pip-installed `yt-dlp` (causing n challenge solver failures)
- **Symptom**: `yt-dlp` fails with `n challenge solving failed` even after Node.js and pip-installed `yt-dlp[default]` are set up in the Dockerfile.
- **Root Cause**: `ensureYtdlp()` was checking for a local standalone binary at `/app/yt-dlp` (downloaded during previous failures or local setups) and preferring it. Standalone binaries downloaded directly from GitHub do not bundle the Embedded JavaScript (EJS) challenge-solving scripts required to bridge `yt-dlp` with the Node.js runtime.
- **Fix**: Improved `ensureYtdlp()` to check absolute system installation paths (e.g., `/usr/local/bin/yt-dlp`) first. If a system package is detected, the bot unlinks any local standalone binary at `/app/yt-dlp` to prevent conflict and uses the system package with full EJS script support.
