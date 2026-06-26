const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  StreamType,
  VoiceConnectionStatus,
  entersState
} = require('@discordjs/voice');
const { MessageFlags } = require('discord.js');
const play = require('play-dl');
const { spawn, execFileSync } = require('child_process');

// Set FFMPEG_PATH to the static ffmpeg binary to avoid requiring manual system installs
let FFMPEG_PATH = 'ffmpeg';
try {
  const ffmpegPath = require('ffmpeg-static');
  if (ffmpegPath) {
    FFMPEG_PATH = ffmpegPath;
    process.env.FFMPEG_PATH = ffmpegPath;
  }
} catch (e) {
  console.warn('Warning: Could not load ffmpeg-static. Falling back to system ffmpeg.');
}

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

let YTDLP_PATH = 'yt-dlp';

function hasSystemYtdlp() {
  try {
    execSync('which yt-dlp', { stdio: 'ignore' });
    return true;
  } catch (e) {
    try {
      execSync('command -v yt-dlp', { stdio: 'ignore' });
      return true;
    } catch (err) {
      return false;
    }
  }
}

async function ensureYtdlp() {
  if (process.env.YTDLP_PATH) {
    YTDLP_PATH = process.env.YTDLP_PATH;
    return;
  }

  if (hasSystemYtdlp()) {
    YTDLP_PATH = 'yt-dlp';
    return;
  }

  const localPath = path.join(__dirname, 'yt-dlp');
  if (fs.existsSync(localPath)) {
    YTDLP_PATH = localPath;
    return;
  }

  console.log('[yt-dlp] Standalone binary not found. Downloading latest release...');
  try {
    const url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(localPath, buffer);
    fs.chmodSync(localPath, '755'); // Make executable
    YTDLP_PATH = localPath;
    console.log('[yt-dlp] Standalone binary downloaded successfully and made executable.');
  } catch (error) {
    console.error('[yt-dlp] Failed to download automatically:', error);
  }
}

// Check and download on startup
ensureYtdlp();


async function getSpotifyEmbedData(query) {
  const urlObj = new URL(query);
  const pathParts = urlObj.pathname.split('/');
  const typeIdx = pathParts.findIndex(p => p === 'track' || p === 'playlist' || p === 'album');
  if (typeIdx === -1) {
    throw new Error('Could not parse Spotify URL type.');
  }
  const type = pathParts[typeIdx];
  const id = pathParts[typeIdx + 1];
  if (!id) {
    throw new Error('Could not parse Spotify ID.');
  }

  const embedUrl = `https://open.spotify.com/embed/${type}/${id}`;
  const response = await fetch(embedUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/101.0.4951.64 Safari/537.36'
    }
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch Spotify embed page: ${response.statusText}`);
  }
  const html = await response.text();
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([^<]+)<\/script>/);
  if (!match) {
    throw new Error('Could not extract Spotify metadata from embed page.');
  }

  const json = JSON.parse(match[1]);
  const entity = json.props?.pageProps?.state?.data?.entity;
  if (!entity) {
    if (json.props?.pageProps?.status === 404 || json.props?.pageProps?.title === 'Page not found') {
      throw new Error('Spotify content not found (404). It might be geoblocked or private.');
    }
    throw new Error('Could not parse Spotify entity state.');
  }

  if (type === 'track') {
    return {
      name: entity.name || entity.title,
      artists: entity.artists || []
    };
  } else if (type === 'playlist' || type === 'album') {
    return {
      name: entity.name || entity.title,
      all_tracks: async () => {
        return (entity.trackList || []).map(t => ({
          name: t.title,
          artists: [{ name: t.subtitle }]
        }));
      }
    };
  }
  return entity;
}

// Global music queues map (key: guildId, value: GuildQueue)
const queues = new Map();

// Stores ephemeral search results per guild until user picks one
const pendingSearchResults = new Map();

class GuildQueue {
  constructor(guildId, textChannel, voiceChannel) {
    this.guildId = guildId;
    this.textChannel = textChannel;
    this.voiceChannel = voiceChannel;
    this.connection = null;
    this.songs = [];
    this.player = createAudioPlayer();
    this.playing = false;
    this.sessionMessages = [];
    this.ytDlpProcess = null;
    this.ffmpegProcess = null;


    // Handle player states
    this.player.on(AudioPlayerStatus.Idle, () => {
      console.log(`[player] State transition: Idle`);
      this.songs.shift(); // Remove completed song
      this.playNext();
    });

    this.player.on(AudioPlayerStatus.Playing, () => {
      console.log(`[player] State transition: Playing`);
    });

    this.player.on(AudioPlayerStatus.Buffering, () => {
      console.log(`[player] State transition: Buffering`);
    });

    this.player.on(AudioPlayerStatus.AutoPaused, () => {
      console.log(`[player] State transition: AutoPaused`);
    });

    this.player.on('debug', message => {
      console.log(`[player-debug] ${message}`);
    });

    this.player.on('error', error => {
      console.error(`[player] Audio player error: ${error.message}`);
      this.textChannel.send(`⚠️ **Audio player error:** ${error.message}. Skipping to next song...`).catch(console.error);
      // Stopping the player will trigger Idle, which handles shifting and playing next
      this.player.stop();
    });
  }

  async connect() {
    console.log(`[voice] Connecting to channel: ${this.voiceChannel.name} (${this.voiceChannel.id})`);
    this.connection = joinVoiceChannel({
      channelId: this.voiceChannel.id,
      guildId: this.guildId,
      adapterCreator: this.voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false
    });

    this.connection.on('debug', message => {
      console.log(`[connection-debug] ${message}`);
    });

    // Handle connection lifecycle
    this.connection.on(VoiceConnectionStatus.Signalling, () => {
      console.log(`[connection] State: Signalling`);
    });
    this.connection.on(VoiceConnectionStatus.Connecting, () => {
      console.log(`[connection] State: Connecting`);
    });
    this.connection.on(VoiceConnectionStatus.Ready, () => {
      console.log(`[connection] State: Ready`);
    });
    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      console.log(`[connection] State: Disconnected`);
      try {
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5000),
        ]);
        // Seems like a temporary reconnect
      } catch (error) {
        // Real disconnect
        console.log(`[connection] Reconnect failed, destroying connection`);
        this.destroy();
      }
    });

    this.connection.subscribe(this.player);
  }

  async addSong(song, user, playTop = false, insertIndex = 1) {
    song.requestedBy = user;
    if (playTop && this.songs.length > 0) {
      this.songs.splice(insertIndex, 0, song);
    } else {
      this.songs.push(song);
    }
    console.log(`[queue] Added song: ${song.title} (${song.url}) (playTop: ${playTop}, insertIndex: ${insertIndex})`);

    if (!this.playing) {
      this.playing = true;
      if (!this.connection) {
        await this.connect();
      }
      this.playNext();
      return null; // Signals it started playing immediately
    }
    return song; // Signals it was queued
  }

  async playNext() {
    if (this.nowPlayingMessage) {
      this.nowPlayingMessage.delete().catch(() => {});
      this.nowPlayingMessage = null;
    }

    if (this.songs.length === 0) {
      this.playing = false;
      console.log(`[queue] Queue is empty.`);
      this.textChannel.send('🎵 Queue is empty. Leaving voice channel soon...')
        .then(msg => {
          this.sessionMessages.push(msg);
          if (!queues.has(this.guildId)) {
            msg.delete().catch(() => {});
          }
        })
        .catch(console.error);
      
      // Auto-disconnect after 1 minute of inactivity
      if (this.disconnectTimeout) clearTimeout(this.disconnectTimeout);
      this.disconnectTimeout = setTimeout(() => {
        if (!this.playing && this.connection) {
          console.log(`[queue] Auto-disconnect due to inactivity`);
          this.destroy();
        }
      }, 60000);
      return;
    }

    if (this.disconnectTimeout) {
      clearTimeout(this.disconnectTimeout);
      this.disconnectTimeout = null;
    }

    const song = this.songs[0];

    // Clean up any existing processes for the previous song
    this.cleanupProcesses();

    try {
      console.log(`[queue] Attempting to play song: ${song.title}`);
      
      const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
      const embed = new EmbedBuilder()
        .setColor('#1DB954') // Spotify green
        .setTitle('🎶 Now Playing')
        .setDescription(`**[${song.title}](${song.url})**`)
        .addFields(
          { name: 'Requested By', value: `${song.requestedBy}`, inline: true },
          { name: 'Duration', value: `\`${song.duration || 'Unknown'}\``, inline: true }
        )
        .setTimestamp();

      const isPaused = this.player.state.status === AudioPlayerStatus.Paused;

      const row = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId('player_pause_resume')
            .setLabel(isPaused ? '▶️ Resume' : '⏸️ Pause')
            .setStyle(isPaused ? ButtonStyle.Success : ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId('player_skip')
            .setLabel('⏭️ Skip')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId('player_stop')
            .setLabel('🛑 Stop')
            .setStyle(ButtonStyle.Danger),
          new ButtonBuilder()
            .setCustomId('player_queue')
            .setLabel('📋 Queue')
            .setStyle(ButtonStyle.Secondary)
        );

      this.textChannel.send({ embeds: [embed], components: [row] })
        .then(msg => {
          this.nowPlayingMessage = msg;
          this.sessionMessages.push(msg);
          if (!queues.has(this.guildId)) {
            msg.delete().catch(() => {});
          }
        })
        .catch(console.error);
      
      // Wait for the voice connection to be READY before subscribing or playing
      if (this.connection) {
        console.log(`[voice] Awaiting voice connection to be Ready...`);
        try {
          await entersState(this.connection, VoiceConnectionStatus.Ready, 10000);
          console.log(`[voice] Voice connection is Ready!`);
        } catch (err) {
          console.error(`[voice] Failed to reach Ready state in 10s:`, err);
        }
      }

      // Use yt-dlp to get the best audio stream URL, then pipe through ffmpeg
      const ytDlpPath = YTDLP_PATH;

      console.log(`[yt-dlp] Spawning yt-dlp for: ${song.url}`);
      const ytDlpArgs = [
        '--remote-components', 'ejs:github',  // Download JS challenge solver from GitHub
        '--no-update',
        '--js-runtimes', `bun:${process.execPath}`,
        '--no-playlist',
        '-f', 'bestaudio[ext=webm]/bestaudio/best',
        '-o', '-',                             // stream to stdout
      ];

      const cookiesPath = path.join(__dirname, 'cookies.txt');
      if (fs.existsSync(cookiesPath)) {
        console.log('[yt-dlp] Found cookies.txt. Passing cookies to yt-dlp.');
        ytDlpArgs.push('--cookies', cookiesPath);
      }

      ytDlpArgs.push(song.url);

      this.ytDlpProcess = spawn(ytDlpPath, ytDlpArgs);

      console.log(`[ffmpeg] Spawning ffmpeg from path: ${FFMPEG_PATH}`);
      this.ffmpegProcess = spawn(FFMPEG_PATH, [
        '-i', 'pipe:0',      // read from stdin (yt-dlp stdout)
        '-vn',
        '-c:a', 'libopus',   // encode using optimized native libopus
        '-ar', '48000',
        '-ac', '2',
        '-b:a', '128k',      // standard high-quality bitrate
        '-f', 'opus',        // output as Ogg Opus stream
        'pipe:1'
      ], { stdio: ['pipe', 'pipe', 'pipe'] }); // Pipe stdin, stdout, stderr

      // Pipe yt-dlp stdout into ffmpeg stdin with error handling
      this.ytDlpProcess.stdout.on('error', err => {
        if (err.code !== 'EPIPE') console.error('[yt-dlp-stdout-error]', err);
      });
      this.ffmpegProcess.stdin.on('error', err => {
        if (err.code !== 'EPIPE') console.error('[ffmpeg-stdin-error]', err);
      });
      this.ytDlpProcess.stdout.pipe(this.ffmpegProcess.stdin);

      this.ytDlpProcess.stderr.on('data', data => {
        const lines = data.toString().split('\n');
        for (let line of lines) {
          line = line.trim();
          if (line) {
            // Filter out the Bun deprecation warning to keep logs clean
            if (line.includes('bun support has been deprecated') || line.includes('github.com/yt-dlp/yt-dlp/issues/16766')) {
              continue;
            }
            console.log(`[yt-dlp-stderr] ${line}`);
          }
        }
      });

      this.ytDlpProcess.on('error', err => console.error('[yt-dlp-error]', err));
      this.ytDlpProcess.on('close', code => {
        console.log(`[yt-dlp] exited with code ${code}`);
      });

      this.ffmpegProcess.stderr.on('data', data => {
        const line = data.toString().trim();
        if (line) console.log(`[ffmpeg-stderr] ${line}`);
      });

      this.ffmpegProcess.on('error', err => console.error('[ffmpeg-error] process error:', err));
      this.ffmpegProcess.on('close', code => {
        console.log(`[ffmpeg] exited with code ${code}`);
      });

      const resource = createAudioResource(this.ffmpegProcess.stdout, {
        inputType: StreamType.OggOpus   // matches Ogg Opus output from ffmpeg
      });

      console.log(`[player] Calling player.play()`);
      this.player.play(resource);
    } catch (error) {
      console.error(`[queue] Error playing song:`, error);
      this.textChannel.send(`⚠️ Failed to play **${song.title}**: ${error.message}`)
        .then(msg => {
          this.sessionMessages.push(msg);
          if (!queues.has(this.guildId)) {
            msg.delete().catch(() => {});
          }
        })
        .catch(console.error);
      this.songs.shift();
      this.playNext();
    }
  }

  removeSong(index) {
    if (index < 1 || index >= this.songs.length) return null;
    const removed = this.songs.splice(index, 1);
    return removed[0];
  }

  skip() {
    if (this.songs.length === 0) return false;
    this.player.stop();
    this.cleanupProcesses();
    return true;
  }

  stop() {
    this.songs = [];
    this.player.stop();
    this.playing = false;
    this.cleanupProcesses();
    this.destroy();
  }

  pause() {
    if (this.player.state.status === AudioPlayerStatus.Playing) {
      this.player.pause();
      return true;
    }
    return false;
  }

  resume() {
    if (this.player.state.status === AudioPlayerStatus.Paused) {
      this.player.unpause();
      return true;
    }
    return false;
  }

  cleanupProcesses() {
    if (this.ytDlpProcess) {
      try {
        console.log(`[cleanup] Killing yt-dlp process (PID: ${this.ytDlpProcess.pid})`);
        this.ytDlpProcess.kill('SIGKILL');
      } catch (e) {}
      this.ytDlpProcess = null;
    }
    if (this.ffmpegProcess) {
      try {
        console.log(`[cleanup] Killing ffmpeg process (PID: ${this.ffmpegProcess.pid})`);
        this.ffmpegProcess.kill('SIGKILL');
      } catch (e) {}
      this.ffmpegProcess = null;
    }
  }

  destroy() {
    console.log(`[destroy] Destroying queue for guild ${this.guildId}`);
    this.cleanupProcesses();
    if (this.disconnectTimeout) clearTimeout(this.disconnectTimeout);
    if (this.emptyTimeout) clearTimeout(this.emptyTimeout);
    
    // Deduplicate all messages that need to be deleted
    const messagesToDelete = new Set();
    if (this.nowPlayingMessage) {
      messagesToDelete.add(this.nowPlayingMessage);
    }
    if (this.sessionMessages) {
      this.sessionMessages.forEach(msg => messagesToDelete.add(msg));
    }
    
    this.nowPlayingMessage = null;
    this.sessionMessages = [];
    
    if (messagesToDelete.size > 0) {
      console.log(`[destroy] Deleting messages, count: ${messagesToDelete.size}`);
      let idx = 0;
      messagesToDelete.forEach((msg) => {
        const currentIdx = idx++;
        msg.delete()
          .then(() => console.log(`[destroy] Successfully deleted message #${currentIdx}`))
          .catch(err => {
            // Silence "Unknown Message" (10008) errors since it means the message was already deleted
            if (err.code === 10008) {
              console.log(`[destroy] Message #${currentIdx} was already deleted.`);
            } else {
              console.error(`[destroy] Error deleting message #${currentIdx}:`, err);
            }
          });
      });
    }
    
    try {
      this.player.stop();
    } catch (e) {}
    try {
      if (this.connection) this.connection.destroy();
    } catch (e) {}
    queues.delete(this.guildId);
  }
}

function isBotDetectionError(error) {
  if (!error || !error.message) return false;
  const msg = error.message.toLowerCase();
  return msg.includes('429') || 
         msg.includes('sign in to confirm') || 
         msg.includes('confirm you\'re not a bot') || 
         msg.includes('confirm you’re not a bot') || 
         msg.includes('sign in to');
}

/**
 * Load a YouTube playlist (any type: regular, Mix, Radio) via yt-dlp --flat-playlist.
 * - Adds the FIRST song to the queue immediately so playback starts right away.
 * - Loads all remaining songs asynchronously in the background.
 * - Replies to the Discord interaction as soon as the first song is queued.
 */
async function loadYtPlaylist(interaction, query, voiceChannel, playTop = false) {
  console.log(`[playlist-loader] Loading YT playlist via yt-dlp --flat-playlist: ${query}`);

  // Run yt-dlp to enumerate all entries (no downloading, very fast)
  let entries;
  try {
    const ytDlpArgs = [
      '--flat-playlist',
      '--print', '%(id)s\t%(title)s\t%(duration_string)s',
      '--no-warnings',
      query
    ];
    const cookiesPath = path.join(__dirname, 'cookies.txt');
    if (fs.existsSync(cookiesPath)) ytDlpArgs.unshift('--cookies', cookiesPath);

    const output = await new Promise((resolve, reject) => {
      const proc = spawn(YTDLP_PATH, ytDlpArgs);
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', d => { stdout += d.toString(); });
      proc.stderr.on('data', d => {
        const line = d.toString();
        // Filter bun deprecation noise
        if (!line.includes('bun support has been deprecated')) stderr += line;
      });
      proc.on('close', code => {
        if (code !== 0 && stdout.trim() === '') reject(new Error(stderr.trim() || `yt-dlp exited ${code}`));
        else resolve(stdout);
      });
      proc.on('error', reject);
    });

    entries = output.trim().split('\n').filter(Boolean).map(line => {
      const [id, title, duration] = line.split('\t');
      return {
        title: title && title !== 'NA' ? title : 'Unknown',
        url: `https://www.youtube.com/watch?v=${id}`,
        duration: duration && duration !== 'NA' ? duration : '?'
      };
    }).filter(e => e.url.includes('watch?v='));
  } catch (err) {
    console.error('[playlist-loader] yt-dlp flat-playlist failed:', err.message);
    return interaction.editReply(`❌ Failed to load playlist: ${err.message}`);
  }

  if (entries.length === 0) {
    return interaction.editReply('❌ No playable tracks found in that playlist.');
  }

  // Set up the queue
  let queue = queues.get(interaction.guildId);
  if (!queue) {
    queue = new GuildQueue(interaction.guildId, interaction.channel, voiceChannel);
    queues.set(interaction.guildId, queue);
  }

  // Add the first song synchronously so playback starts immediately
  const firstInsertIndex = playTop ? 1 : undefined;
  await queue.addSong(entries[0], interaction.user, playTop, firstInsertIndex);

  // Reply immediately so Discord doesn't time out
  await interaction.editReply(
    `▶️ Now queuing **${entries.length}** songs — starting with **${entries[0].title}**...\n` +
    `_(remaining tracks loading in background)_`
  );

  // Load the rest asynchronously — don't await, fire and forget
  (async () => {
    let insertIndex = playTop ? 2 : undefined;
    for (let i = 1; i < entries.length; i++) {
      // If the queue was destroyed (user ran /stop), stop loading
      if (!queues.has(interaction.guildId)) {
        console.log(`[playlist-loader] Queue was destroyed mid-load, stopping at ${i}/${entries.length}`);
        break;
      }
      await queue.addSong(entries[i], interaction.user, playTop, insertIndex);
      if (playTop && insertIndex !== undefined) insertIndex++;
    }
    console.log(`[playlist-loader] Finished loading ${entries.length} tracks into queue.`);
    // Send a follow-up once all songs are loaded
    interaction.followUp({
      content: `✅ Fully loaded **${entries.length}** songs into the ${playTop ? 'top of the ' : ''}queue!`,
    }).catch(() => {});
  })();

  return;
}

/**
 * Main module interfaces
 */
async function handlePlay(interaction, query, playTop = false) {
  const voiceChannel = interaction.member.voice.channel;
  if (!voiceChannel) {
    return interaction.reply({ content: '❌ You need to join a voice channel first!', flags: MessageFlags.Ephemeral });
  }

  const permissions = voiceChannel.permissionsFor(interaction.client.user);
  if (!permissions.has('Connect') || !permissions.has('Speak')) {
    return interaction.reply({ content: '❌ I do not have permissions to join or speak in your voice channel!', flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply();

  try {
    let songInfo = null;

    // Normalize YouTube Music URLs (music.youtube.com) to regular YouTube URLs
    // play-dl cannot parse the music.youtube.com internal JSON structure
    try {
      const urlObj = new URL(query);
      if (urlObj.hostname === 'music.youtube.com') {
        urlObj.hostname = 'www.youtube.com';
        // Strip YTM-specific params that confuse play-dl
        urlObj.searchParams.delete('playnext');
        urlObj.searchParams.delete('si');
        query = urlObj.toString();
        console.log(`[play] Normalized YouTube Music URL to: ${query}`);
      }
    } catch (_) {
      // Not a URL — leave query as-is (plain search string)
    }

    // Validate the query type (YT video, playlist, soundcloud, spotify, etc.)
    const validationType = await play.validate(query);

    if (validationType === 'yt_video' || validationType === 'yt_playlist' || validationType === 'search') {
      if (validationType === 'search') {
        const searchResults = await play.search(query, { limit: 1 });
        if (searchResults.length === 0) {
          return interaction.editReply(`❌ No results found for: \`${query}\``);
        }
        songInfo = {
          title: searchResults[0].title,
          url: searchResults[0].url,
          duration: searchResults[0].durationRaw
        };
      } else if (validationType === 'yt_playlist' || (validationType === 'yt_video' && query.includes('list='))) {
        return await loadYtPlaylist(interaction, query, voiceChannel, playTop);
      } else if (validationType === 'yt_video') {
        const videoInfo = await play.video_info(query);
        songInfo = {
          title: videoInfo.video_details.title,
          url: videoInfo.video_details.url,
          duration: videoInfo.video_details.durationRaw
        };
      }
    } else if (validationType === 'sp_track' || validationType === 'sp_playlist' || validationType === 'sp_album') {
      // play-dl handles spotify redirection to youtube automatically
      if (typeof play.is_spotify_creds_present === 'function' && play.is_spotify_creds_present()) {
        // Handle native spotify streaming if credentials are configured
      }
      
      // Standard flow: search youtube for spotify tracks
      let spData;
      try {
        spData = await play.spotify(query);
      } catch (err) {
        if (err.message && err.message.includes('Spotify Data is missing')) {
          console.log('[spotify] Credentials missing, falling back to embed player scraping...');
          spData = await getSpotifyEmbedData(query);
        } else {
          throw err;
        }
      }
      if (validationType === 'sp_track') {
        const searchResults = await play.search(`${spData.name} ${spData.artists.map(a => a.name).join(' ')}`, { limit: 1 });
        if (searchResults.length === 0) {
          return interaction.editReply(`❌ Could not find YouTube match for Spotify track: **${spData.name}**`);
        }
        songInfo = {
          title: spData.name,
          url: searchResults[0].url,
          duration: searchResults[0].durationRaw
        };
      } else {
        // Spotify Playlist or Album
        const tracks = await spData.all_tracks();
        await interaction.editReply(`🔍 Fetching YouTube counterparts for **${tracks.length}** Spotify tracks...`);
        
        let queue = queues.get(interaction.guildId);
        if (!queue) {
          queue = new GuildQueue(interaction.guildId, interaction.channel, voiceChannel);
          queues.set(interaction.guildId, queue);
        }

        let loadedCount = 0;
        let insertIndex = 1;
        for (const track of tracks) {
          const searchResults = await play.search(`${track.name} ${track.artists.map(a => a.name).join(' ')}`, { limit: 1 });
          if (searchResults.length > 0) {
            await queue.addSong({
              title: track.name,
              url: searchResults[0].url,
              duration: searchResults[0].durationRaw
            }, interaction.user, playTop, insertIndex++);
            loadedCount++;
          }
        }
        return interaction.followUp(`✅ Loaded **${loadedCount}** tracks from Spotify list to the ${playTop ? 'top of the ' : ''}queue!`);
      }
    } else {
      // Check if this is a YouTube URL with a playlist parameter that play.validate() didn't recognise
      // (e.g. YouTube Mix / Radio playlists: LRYR…, RDLR…, RD…, etc.)
      let isYtPlaylistUrl = false;
      try {
        const u = new URL(query);
        isYtPlaylistUrl =
          (u.hostname === 'www.youtube.com' || u.hostname === 'youtube.com' || u.hostname === 'youtu.be') &&
          u.searchParams.has('list');
      } catch (_) {}

      if (isYtPlaylistUrl) {
        return await loadYtPlaylist(interaction, query, voiceChannel, playTop);
      } else {
        // Plain text search fallback
        const searchResults = await play.search(query, { limit: 1 });
        if (searchResults.length === 0) {
          return interaction.editReply(`❌ Unsupported URL or no search results for: \`${query}\``);
        }
        songInfo = {
          title: searchResults[0].title,
          url: searchResults[0].url,
          duration: searchResults[0].durationRaw
        };
      }
    }

    if (!songInfo) {
      return interaction.editReply('❌ Failed to retrieve song information.');
    }

    let queue = queues.get(interaction.guildId);
    if (!queue) {
      queue = new GuildQueue(interaction.guildId, interaction.channel, voiceChannel);
      queues.set(interaction.guildId, queue);
    }

    const queuedSong = await queue.addSong(songInfo, interaction.user, playTop);

    if (queuedSong) {
      const messageText = playTop 
        ? `📝 **Queued to top:** [${queuedSong.title}](${queuedSong.url}) [${queuedSong.duration}]`
        : `📝 **Queued:** [${queuedSong.title}](${queuedSong.url}) [${queuedSong.duration}]`;
      return interaction.editReply(messageText)
        .then(msg => {
          queue.sessionMessages.push(msg);
          setTimeout(() => {
            if (queues.has(interaction.guildId) && queue.sessionMessages.includes(msg)) {
              msg.delete().catch(() => {});
              queue.sessionMessages = queue.sessionMessages.filter(m => m !== msg);
            }
          }, 10000);
        });
    } else {
      return interaction.editReply(`🔊 Now playing **${songInfo.title}**!`)
        .then(msg => {
          queue.sessionMessages.push(msg);
          setTimeout(() => {
            if (queues.has(interaction.guildId) && queue.sessionMessages.includes(msg)) {
              msg.delete().catch(() => {});
              queue.sessionMessages = queue.sessionMessages.filter(m => m !== msg);
            }
          }, 10000);
        });
    }
  } catch (error) {
    console.error(error);
    const msgText = isBotDetectionError(error)
      ? '❌ YouTube is currently blocking our requests (bot verification / rate limit). Please try another video link or search query.'
      : `⚠️ An error occurred while trying to play: ${error.message}`;
    return interaction.editReply(msgText)
      .then(msg => {
        const queue = queues.get(interaction.guildId);
        if (queue) {
          queue.sessionMessages.push(msg);
          setTimeout(() => {
            if (queues.has(interaction.guildId) && queue.sessionMessages.includes(msg)) {
              msg.delete().catch(() => {});
              queue.sessionMessages = queue.sessionMessages.filter(m => m !== msg);
            }
          }, 10000);
        } else {
          setTimeout(() => msg.delete().catch(() => {}), 10000);
        }
      });
  }
}

function handleSkip(interaction) {
  const queue = queues.get(interaction.guildId);
  if (!queue || queue.songs.length === 0) {
    return interaction.reply({ content: '❌ There is no music playing to skip!', flags: MessageFlags.Ephemeral });
  }

  const success = queue.skip();
  if (success) {
    return interaction.reply({ content: '⏭️ Skipped the current song!', fetchReply: true })
      .then(msg => {
        queue.sessionMessages.push(msg);
        setTimeout(() => {
          if (queues.has(interaction.guildId) && queue.sessionMessages.includes(msg)) {
            msg.delete().catch(() => {});
            queue.sessionMessages = queue.sessionMessages.filter(m => m !== msg);
          }
        }, 5000);
      });
  } else {
    return interaction.reply({ content: '❌ No songs left in the queue to skip.', fetchReply: true })
      .then(msg => setTimeout(() => msg.delete().catch(() => {}), 5000));
  }
}

function handleStop(interaction) {
  const queue = queues.get(interaction.guildId);
  if (!queue) {
    return interaction.reply({ content: '❌ I am not playing any music in this server!', flags: MessageFlags.Ephemeral });
  }

  queue.stop();
  return interaction.reply({ content: '🛑 Stopped playing music and left the voice channel.', fetchReply: true })
    .then(msg => setTimeout(() => msg.delete().catch(() => {}), 5000));
}

function handlePause(interaction) {
  const queue = queues.get(interaction.guildId);
  if (!queue) {
    return interaction.reply({ content: '❌ I am not playing any music in this server!', flags: MessageFlags.Ephemeral });
  }

  const paused = queue.pause();
  if (paused) {
    return interaction.reply({ content: '⏸️ Paused the music.', fetchReply: true })
      .then(msg => {
        queue.sessionMessages.push(msg);
        setTimeout(() => {
          if (queues.has(interaction.guildId) && queue.sessionMessages.includes(msg)) {
            msg.delete().catch(() => {});
            queue.sessionMessages = queue.sessionMessages.filter(m => m !== msg);
          }
        }, 5000);
      });
  } else {
    return interaction.reply({ content: '❌ Music is already paused or not playing!', flags: MessageFlags.Ephemeral });
  }
}

function handleResume(interaction) {
  const queue = queues.get(interaction.guildId);
  if (!queue) {
    return interaction.reply({ content: '❌ I am not playing any music in this server!', flags: MessageFlags.Ephemeral });
  }

  const resumed = queue.resume();
  if (resumed) {
    return interaction.reply({ content: '▶️ Resumed the music.', fetchReply: true })
      .then(msg => {
        queue.sessionMessages.push(msg);
        setTimeout(() => {
          if (queues.has(interaction.guildId) && queue.sessionMessages.includes(msg)) {
            msg.delete().catch(() => {});
            queue.sessionMessages = queue.sessionMessages.filter(m => m !== msg);
          }
        }, 5000);
      });
  } else {
    return interaction.reply({ content: '❌ Music is already playing or not paused!', flags: MessageFlags.Ephemeral });
  }
}

function handleQueue(interaction) {
  const queue = queues.get(interaction.guildId);
  if (!queue || queue.songs.length === 0) {
    return interaction.reply('📭 The queue is currently empty.');
  }

  const songList = queue.songs
    .slice(0, 10)
    .map((song, index) => `${index === 0 ? '▶️' : `${index}.`} **${song.title}** (${song.duration}) - Requested by ${song.requestedBy}`)
    .join('\n');

  const totalSongs = queue.songs.length;
  const queueMessage = `__**Current Queue:**__\n${songList}\n\n${totalSongs > 10 ? `*...and ${totalSongs - 10} more songs.*` : ''}`;
  
  return interaction.reply({ content: queueMessage, fetchReply: true })
    .then(msg => {
      queue.sessionMessages.push(msg);
      setTimeout(() => {
        if (queues.has(interaction.guildId) && queue.sessionMessages.includes(msg)) {
          msg.delete().catch(() => {});
          queue.sessionMessages = queue.sessionMessages.filter(m => m !== msg);
        }
      }, 15000);
    });
}

function handleRemove(interaction) {
  const queue = queues.get(interaction.guildId);
  if (!queue || queue.songs.length <= 1) {
    return interaction.reply({ content: '❌ The queue is empty (or only has the currently playing song)!', flags: MessageFlags.Ephemeral });
  }

  const { ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');

  const upcomingSongs = queue.songs.slice(1, 26); // Select menus support max 25 options
  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId('remove_select')
    .setPlaceholder('Select song(s) to remove from the queue...')
    .setMinValues(1)
    .setMaxValues(upcomingSongs.length)
    .addOptions(
      upcomingSongs.map((song, i) => {
        const actualIndex = i + 1;
        const displayTitle = song.title.length > 80 ? song.title.slice(0, 77) + '...' : song.title;
        const requestedByName = song.requestedBy?.username || song.requestedBy?.tag || String(song.requestedBy);
        return {
          label: `#${actualIndex}: ${displayTitle}`,
          description: `Requested by ${requestedByName} • ${song.duration}`,
          value: `${actualIndex}|${song.url}`
        };
      })
    );

  const row = new ActionRowBuilder().addComponents(selectMenu);

  return interaction.reply({
    content: '🗑️ Select the song(s) you want to remove:',
    components: [row],
    flags: MessageFlags.Ephemeral
  });
}

async function handleJoin(interaction) {
  const voiceChannel = interaction.member.voice.channel;
  if (!voiceChannel) {
    return interaction.reply({ content: '❌ You need to join a voice channel first!', flags: MessageFlags.Ephemeral });
  }

  const existingQueue = queues.get(interaction.guildId);
  if (existingQueue && existingQueue.connection) {
    return interaction.reply({ content: `✅ Already connected to **${existingQueue.voiceChannel.name}**!`, flags: MessageFlags.Ephemeral });
  }

  const queue = new GuildQueue(interaction.guildId, interaction.channel, voiceChannel);
  queues.set(interaction.guildId, queue);
  await queue.connect();

  return interaction.reply({ content: `✅ Joined **${voiceChannel.name}**! Use \`/play\` to start music.`, fetchReply: true })
    .then(msg => {
      queue.sessionMessages.push(msg);
      setTimeout(() => {
        if (queues.has(interaction.guildId) && queue.sessionMessages.includes(msg)) {
          msg.delete().catch(() => {});
          queue.sessionMessages = queue.sessionMessages.filter(m => m !== msg);
        }
      }, 10000);
    });
}

function handleLeave(interaction) {
  const queue = queues.get(interaction.guildId);

  // Check if bot is in a voice channel via the queue
  if (queue && queue.connection) {
    queue.destroy();
    return interaction.reply({ content: '👋 Left the voice channel and cleared the queue.', fetchReply: true })
      .then(msg => setTimeout(() => msg.delete().catch(() => {}), 5000));
  }

  // Check if bot is in a voice channel at all (even without a queue)
  const botVoiceChannel = interaction.guild.members.me?.voice?.channel;
  if (botVoiceChannel) {
    const { getVoiceConnection } = require('@discordjs/voice');
    const connection = getVoiceConnection(interaction.guildId);
    if (connection) connection.destroy();
    return interaction.reply({ content: '👋 Left the voice channel.', fetchReply: true })
      .then(msg => setTimeout(() => msg.delete().catch(() => {}), 5000));
  }

  return interaction.reply({ content: '❌ I am not in a voice channel!', flags: MessageFlags.Ephemeral });
}

async function handleMove(interaction) {
  const voiceChannel = interaction.member.voice.channel;
  if (!voiceChannel) {
    return interaction.reply({ content: '❌ You need to join a voice channel first!', flags: MessageFlags.Ephemeral });
  }

  const queue = queues.get(interaction.guildId);
  if (!queue) {
    // If no queue exists, just join normally
    const newQueue = new GuildQueue(interaction.guildId, interaction.channel, voiceChannel);
    queues.set(interaction.guildId, newQueue);
    await newQueue.connect();
    return interaction.reply({ content: `🔊 Joined and bound to **${voiceChannel.name}**!`, fetchReply: true })
      .then(msg => {
        newQueue.sessionMessages.push(msg);
        setTimeout(() => {
          if (queues.has(interaction.guildId) && newQueue.sessionMessages.includes(msg)) {
            msg.delete().catch(() => {});
            newQueue.sessionMessages = newQueue.sessionMessages.filter(m => m !== msg);
          }
        }, 10000);
      });
  }

  if (queue.voiceChannel.id === voiceChannel.id) {
    return interaction.reply({ content: `❌ I am already in your voice channel!`, flags: MessageFlags.Ephemeral });
  }

  // Move connection to new VC
  queue.voiceChannel = voiceChannel;
  queue.textChannel = interaction.channel; // Update text channel to the one where command was run

  queue.connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: queue.guildId,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    selfDeaf: true,
    selfMute: false
  });

  queue.connection.subscribe(queue.player);

  return interaction.reply({ content: `🚚 Moved to **${voiceChannel.name}**!`, fetchReply: true })
    .then(msg => {
      queue.sessionMessages.push(msg);
      setTimeout(() => {
        if (queues.has(interaction.guildId) && queue.sessionMessages.includes(msg)) {
          msg.delete().catch(() => {});
          queue.sessionMessages = queue.sessionMessages.filter(m => m !== msg);
        }
      }, 10000);
    });
}

async function handleControls(interaction) {
  const queue = queues.get(interaction.guildId);
  if (!queue || queue.songs.length === 0) {
    return interaction.reply({ content: '❌ There is no music playing to show controls for!', flags: MessageFlags.Ephemeral });
  }

  const song = queue.songs[0];
  const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
  
  const isPaused = queue.player.state.status === AudioPlayerStatus.Paused;
  
  const embed = new EmbedBuilder()
    .setColor('#1DB954')
    .setTitle('🎛️ Music Controls')
    .setDescription(`**Now Playing:** [${song.title}](${song.url})`)
    .addFields(
      { name: 'Requested By', value: `${song.requestedBy}`, inline: true },
      { name: 'Duration', value: `\`${song.duration || 'Unknown'}\``, inline: true }
    )
    .setTimestamp();

  const row = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('player_pause_resume')
        .setLabel(isPaused ? '▶️ Resume' : '⏸️ Pause')
        .setStyle(isPaused ? ButtonStyle.Success : ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('player_skip')
        .setLabel('⏭️ Skip')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('player_stop')
        .setLabel('🛑 Stop')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('player_queue')
        .setLabel('📋 Queue')
        .setStyle(ButtonStyle.Secondary)
    );

  return interaction.reply({ embeds: [embed], components: [row] });
}

async function handleButton(interaction) {
  const queue = queues.get(interaction.guildId);
  if (!queue) {
    return interaction.reply({ content: '❌ No active player in this server.', flags: MessageFlags.Ephemeral });
  }

  // Ensure member is in the same voice channel
  const memberVoiceChannel = interaction.member.voice.channel;
  if (!memberVoiceChannel || memberVoiceChannel.id !== queue.voiceChannel.id) {
    return interaction.reply({ content: '❌ You need to be in the same voice channel as the bot to use controls!', flags: MessageFlags.Ephemeral });
  }

  const { customId } = interaction;

  try {
    if (customId === 'player_pause_resume') {
      const isPaused = queue.player.state.status === AudioPlayerStatus.Paused;
      const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
      
      if (isPaused) {
        queue.resume();
        const row = new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder()
              .setCustomId('player_pause_resume')
              .setLabel('⏸️ Pause')
              .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
              .setCustomId('player_skip')
              .setLabel('⏭️ Skip')
              .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
              .setCustomId('player_stop')
              .setLabel('🛑 Stop')
              .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
              .setCustomId('player_queue')
              .setLabel('📋 Queue')
              .setStyle(ButtonStyle.Secondary)
          );
        await interaction.message.edit({ components: [row] }).catch(console.error);
        return interaction.reply({ content: '▶️ Resumed the music.', flags: MessageFlags.Ephemeral });
      } else {
        queue.pause();
        const row = new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder()
              .setCustomId('player_pause_resume')
              .setLabel('▶️ Resume')
              .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
              .setCustomId('player_skip')
              .setLabel('⏭️ Skip')
              .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
              .setCustomId('player_stop')
              .setLabel('🛑 Stop')
              .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
              .setCustomId('player_queue')
              .setLabel('📋 Queue')
              .setStyle(ButtonStyle.Secondary)
          );
        await interaction.message.edit({ components: [row] }).catch(console.error);
        return interaction.reply({ content: '⏸️ Paused the music.', flags: MessageFlags.Ephemeral });
      }
    } else if (customId === 'player_skip') {
      const success = queue.skip();
      if (success) {
        return interaction.reply({ content: '⏭️ Skipped the current song!', flags: MessageFlags.Ephemeral });
      } else {
        return interaction.reply({ content: '❌ No songs left in the queue to skip.', flags: MessageFlags.Ephemeral });
      }
    } else if (customId === 'player_stop') {
      queue.stop();
      return interaction.reply({ content: '🛑 Stopped playing music and left the voice channel.', flags: MessageFlags.Ephemeral });
    } else if (customId === 'player_queue') {
      if (queue.songs.length === 0) {
        return interaction.reply({ content: '📭 The queue is currently empty.', flags: MessageFlags.Ephemeral });
      }

      const songList = queue.songs
        .slice(0, 10)
        .map((song, index) => `${index === 0 ? '▶️' : `${index}.`} **${song.title}** (${song.duration}) - Requested by ${song.requestedBy}`)
        .join('\n');

      const totalSongs = queue.songs.length;
      const queueMessage = `__**Current Queue:**__\n${songList}\n\n${totalSongs > 10 ? `*...and ${totalSongs - 10} more songs.*` : ''}`;
      return interaction.reply({ content: queueMessage, flags: MessageFlags.Ephemeral });
    }
  } catch (error) {
    console.error('[button-error]', error);
    return interaction.reply({ content: `⚠️ Failed to handle action: ${error.message}`, flags: MessageFlags.Ephemeral });
  }
}

/**
 * /find  – search YouTube for up to 5 results, show a Select Menu to pick one.
 */
async function handleFind(interaction, query) {
  // Defer as ephemeral so only the invoking user sees the search results
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const results = await play.search(query, { limit: 5, source: { youtube: 'video' } });

    if (!results || results.length === 0) {
      return interaction.editReply(`❌ No results found for: \`${query}\``);
    }

    const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');

    // Key by userId so multiple users can search simultaneously in the same guild
    pendingSearchResults.set(interaction.user.id, {
      results: results.map(v => ({
        title: v.title,
        url: v.url,
        duration: v.durationRaw
      })),
      requestedBy: interaction.user
    });

    // Auto-expire after 60 seconds
    setTimeout(() => pendingSearchResults.delete(interaction.user.id), 60000);

    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle(`🔍 Search results for: ${query}`)
      .setDescription(
        results
          .map((v, i) => `**${i + 1}.** [${v.title}](${v.url}) \`${v.durationRaw}\``)
          .join('\n')
      )
      .setFooter({ text: 'Select one or more songs from the dropdown below • expires in 60s' })
      .setTimestamp();

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('find_select')
      .setPlaceholder('Pick songs to queue...')
      .setMinValues(1)
      .setMaxValues(results.length)
      .addOptions(
        results.map((v, i) => ({
          label: v.title.length > 100 ? v.title.slice(0, 97) + '...' : v.title,
          description: `Duration: ${v.durationRaw}`,
          value: String(i)
        }))
      );

    const row = new ActionRowBuilder().addComponents(selectMenu);

    return interaction.editReply({ embeds: [embed], components: [row] });
  } catch (error) {
    console.error('[find-error]', error);
    return interaction.editReply(`⚠️ An error occurred while searching: ${error.message}`);
  }
}

/**
 * Handles the select-menu interaction created by /find.
 */
async function handleSelectMenu(interaction) {
  if (interaction.customId === 'remove_select') {
    const queue = queues.get(interaction.guildId);
    if (!queue || queue.songs.length <= 1) {
      return interaction.reply({ content: '❌ The queue is empty or has changed.', flags: MessageFlags.Ephemeral });
    }

    const toRemove = [];
    for (const val of interaction.values) {
      const [indexStr, url] = val.split('|');
      const index = parseInt(indexStr, 10);
      if (queue.songs[index] && queue.songs[index].url === url) {
        toRemove.push(index);
      }
    }

    if (toRemove.length === 0) {
      return interaction.reply({ content: '❌ The selected songs are no longer in the queue at those positions.', flags: MessageFlags.Ephemeral });
    }

    // Sort descending to prevent index shift on splice
    toRemove.sort((a, b) => b - a);

    const removedSongs = [];
    for (const index of toRemove) {
      const [removed] = queue.songs.splice(index, 1);
      removedSongs.push(removed);
    }

    const removedNames = removedSongs.map(s => `**${s.title}**`).reverse().join('\n');
    return interaction.update({
      content: `🗑️ Removed the following song(s) from the queue:\n${removedNames}`,
      components: []
    });
  }

  if (interaction.customId !== 'find_select') return;

  // Look up by the interacting user's ID (matches how handleFind stored it)
  const pending = pendingSearchResults.get(interaction.user.id);
  if (!pending) {
    // Acknowledge the interaction before replying to avoid "interaction failed"
    return interaction.reply({ content: '⏰ This search has expired. Run `/find` again.', flags: MessageFlags.Ephemeral });
  }

  // Guard: only the user who ran /find can use their own dropdown
  if (pending.requestedBy.id !== interaction.user.id) {
    return interaction.reply({ content: '❌ This search belongs to someone else!', flags: MessageFlags.Ephemeral });
  }

  // Resolve all selected indices to song objects
  const selectedSongs = interaction.values
    .map(v => pending.results[parseInt(v, 10)])
    .filter(Boolean);

  if (selectedSongs.length === 0) {
    return interaction.reply({ content: '❌ Invalid selection.', flags: MessageFlags.Ephemeral });
  }

  // Remove the pending entry now that a choice was made
  pendingSearchResults.delete(interaction.user.id);

  // Ensure the user is in a voice channel before acknowledging
  const voiceChannel = interaction.member.voice.channel;
  if (!voiceChannel) {
    return interaction.reply({ content: '❌ You need to join a voice channel first!', flags: MessageFlags.Ephemeral });
  }

  const permissions = voiceChannel.permissionsFor(interaction.client.user);
  if (!permissions.has('Connect') || !permissions.has('Speak')) {
    return interaction.reply({ content: '❌ I do not have permission to join or speak in your voice channel!', flags: MessageFlags.Ephemeral });
  }

  // deferUpdate() acknowledges the component interaction correctly for both ephemeral and non-ephemeral messages.
  await interaction.deferUpdate();

  // Collapse the dropdown
  await interaction.editReply({ components: [] }).catch(() => {});

  // Set up the queue
  let queue = queues.get(interaction.guildId);
  if (!queue) {
    queue = new GuildQueue(interaction.guildId, interaction.channel, voiceChannel);
    queues.set(interaction.guildId, queue);
  }

  // Add all selected songs
  for (const song of selectedSongs) {
    await queue.addSong(song, interaction.user);
  }

  // Confirmation follow-up
  const addedList = selectedSongs.map(s => `• **${s.title}**`).join('\n');
  const confirmMsg = await interaction.followUp({
    content: selectedSongs.length === 1
      ? `🎵 Added **${selectedSongs[0].title}** to the queue!`
      : `🎵 Added **${selectedSongs.length}** songs to the queue:\n${addedList}`,
    flags: MessageFlags.Ephemeral
  }).catch(() => null);

  if (confirmMsg) setTimeout(() => confirmMsg.delete().catch(() => {}), 10000);
}

function handleVoiceStateUpdate(oldState, newState) {
  const guildId = oldState.guild.id || newState.guild.id;
  const queue = queues.get(guildId);
  if (!queue || !queue.connection) return;

  const botChannelId = queue.voiceChannel.id;

  // Case 1: Someone left the bot's voice channel
  if (oldState.channelId === botChannelId && newState.channelId !== botChannelId) {
    const channel = oldState.guild.channels.cache.get(botChannelId);
    if (!channel) return;

    // Count non-bot members
    const humans = channel.members.filter(member => !member.user.bot);
    console.log(`[voice-check] User left VC. Human count: ${humans.size}`);

    if (humans.size === 0) {
      console.log(`[voice] VC is now empty of humans. Starting 15s leave timer.`);
      if (queue.emptyTimeout) clearTimeout(queue.emptyTimeout);

      queue.emptyTimeout = setTimeout(() => {
        const currentChannel = oldState.guild.channels.cache.get(botChannelId);
        if (currentChannel) {
          const currentHumans = currentChannel.members.filter(member => !member.user.bot);
          if (currentHumans.size === 0) {
            console.log(`[voice] VC remained empty for 15s. Bot leaving.`);
            queue.textChannel.send('🔇 **Voice channel is empty. Leaving...**')
              .then(msg => {
                setTimeout(() => msg.delete().catch(() => {}), 5000);
              })
              .catch(console.error);
            queue.destroy();
          }
        }
      }, 15000);
    }
  }

  // Case 2: Someone joined the bot's voice channel (cancel timer if running)
  if (newState.channelId === botChannelId && oldState.channelId !== botChannelId) {
    const channel = newState.guild.channels.cache.get(botChannelId);
    if (channel) {
      const humans = channel.members.filter(member => !member.user.bot);
      console.log(`[voice-check] User joined VC. Human count: ${humans.size}`);
      if (humans.size > 0 && queue.emptyTimeout) {
        console.log(`[voice] Human joined. Cancelling 15s leave timer.`);
        clearTimeout(queue.emptyTimeout);
        queue.emptyTimeout = null;
      }
    }
  }
}

module.exports = {
  handlePlay,
  handleFind,
  handleSelectMenu,
  handleSkip,
  handleStop,
  handlePause,
  handleResume,
  handleQueue,
  handleRemove,
  handleJoin,
  handleLeave,
  handleMove,
  handleControls,
  handleButton,
  handleVoiceStateUpdate
};
