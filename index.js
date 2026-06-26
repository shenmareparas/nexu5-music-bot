require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const musicPlayer = require('./musicPlayer');

// Ensure token and client ID exist
if (!process.env.DISCORD_TOKEN) {
  console.error('CRITICAL: DISCORD_TOKEN is missing in the .env file.');
  process.exit(1);
}
if (!process.env.CLIENT_ID) {
  console.error('CRITICAL: CLIENT_ID is missing in the .env file.');
  process.exit(1);
}

// Define bot intents (Guilds, GuildVoiceStates, GuildMessages)
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages
  ]
});

// Definition of commands
const commands = [
  new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Skip current song'),
  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop music and leave'),
  new SlashCommandBuilder()
    .setName('pause')
    .setDescription('Pause music'),
  new SlashCommandBuilder()
    .setName('chup')
    .setDescription('Chup kar! (Pause)'),
  new SlashCommandBuilder()
    .setName('resume')
    .setDescription('Resume music'),
  new SlashCommandBuilder()
    .setName('bhok')
    .setDescription('Bhok na! (Resume)'),
  new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Show queue'),
  new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Leave voice channel'),
  new SlashCommandBuilder()
    .setName('nikal')
    .setDescription('Nikal yahan se! (Leave)'),
  new SlashCommandBuilder()
    .setName('join')
    .setDescription('Join voice channel'),
  new SlashCommandBuilder()
    .setName('move')
    .setDescription('Move the bot to your current voice channel'),
  new SlashCommandBuilder()
    .setName('controls')
    .setDescription('Show music playback controls'),
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a song')
    .addStringOption(option =>
      option.setName('query')
        .setDescription('Song name or link')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('suna')
    .setDescription('Kuch acha suna! (Play)')
    .addStringOption(option =>
      option.setName('query')
        .setDescription('Song name or link')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('playtop')
    .setDescription('Add a song to the top of the queue')
    .addStringOption(option =>
      option.setName('query')
        .setDescription('Song name or link')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('pehle')
    .setDescription('Pehle ye suna! (Play at the top of the queue)')
    .addStringOption(option =>
      option.setName('query')
        .setDescription('Song name or link')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('find')
    .setDescription('Search for songs and pick one to play')
    .addStringOption(option =>
      option.setName('query')
        .setDescription('Song name to search for')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Remove song(s) from the queue')
].map(command => command.toJSON());

// Slash commands registration
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

async function registerCommands() {
  try {
    const guildId = process.env.DEV_GUILD_ID;
    
    if (guildId) {
      console.log(`Started refreshing application (/) commands for developer Guild: ${guildId}`);
      await rest.put(
        Routes.applicationGuildCommands(process.env.CLIENT_ID, guildId),
        { body: commands }
      );
      console.log('Successfully reloaded application (/) commands for dev Guild!');

      // Automatically clear global commands to prevent duplicates in the UI
      try {
        await rest.put(
          Routes.applicationCommands(process.env.CLIENT_ID),
          { body: [] }
        );
        console.log('Cleared global application (/) commands to prevent duplicates.');
      } catch (err) {
        console.warn('Could not clear global commands:', err.message);
      }
    } else {
      console.log('Started refreshing application (/) commands globally.');
      await rest.put(
        Routes.applicationCommands(process.env.CLIENT_ID),
        { body: commands }
      );
      console.log('Successfully reloaded application (/) commands globally!');
    }
  } catch (error) {
    console.error('Failed to register application commands:', error);
  }
}

// Handle ready state
client.once('clientReady', async () => {
  console.log(`🤖 NEXU5 Music: Logged in as ${client.user.tag}!`);
  
  // Update status activity
  client.user.setActivity({
    name: '/play',
    type: 2 // Listening
  });

  // Register commands on startup
  await registerCommands();
});

// Handle commands and button interactions
client.on('interactionCreate', async interaction => {
  if (interaction.isChatInputCommand()) {
    const { commandName } = interaction;

    if (commandName === 'play' || commandName === 'suna') {
      const query = interaction.options.getString('query');
      await musicPlayer.handlePlay(interaction, query);
    } else if (commandName === 'playtop' || commandName === 'pehle') {
      const query = interaction.options.getString('query');
      await musicPlayer.handlePlay(interaction, query, true);
    } else if (commandName === 'skip') {
      await musicPlayer.handleSkip(interaction);
    } else if (commandName === 'stop') {
      await musicPlayer.handleStop(interaction);
    } else if (commandName === 'pause' || commandName === 'chup') {
      await musicPlayer.handlePause(interaction);
    } else if (commandName === 'resume' || commandName === 'bhok') {
      await musicPlayer.handleResume(interaction);
    } else if (commandName === 'queue') {
      await musicPlayer.handleQueue(interaction);
    } else if (commandName === 'leave' || commandName === 'nikal') {
      await musicPlayer.handleLeave(interaction);
    } else if (commandName === 'join') {
      await musicPlayer.handleJoin(interaction);
    } else if (commandName === 'move') {
      await musicPlayer.handleMove(interaction);
    } else if (commandName === 'controls') {
      await musicPlayer.handleControls(interaction);
    } else if (commandName === 'find') {
      const query = interaction.options.getString('query');
      await musicPlayer.handleFind(interaction, query);
    } else if (commandName === 'remove') {
      await musicPlayer.handleRemove(interaction);
    }
  } else if (interaction.isButton()) {
    await musicPlayer.handleButton(interaction);
  } else if (interaction.isStringSelectMenu()) {
    await musicPlayer.handleSelectMenu(interaction);
  }
});

// Track voice state updates for empty channel timeout
client.on('voiceStateUpdate', (oldState, newState) => {
  musicPlayer.handleVoiceStateUpdate(oldState, newState);
});

// Global error handlers to keep the bot running
process.on('unhandledRejection', error => {
  console.error('Unhandled promise rejection:', error);
});

process.on('uncaughtException', error => {
  console.error('Uncaught exception:', error);
});

// Log in to Discord
client.on('debug', msg => {
  // Only log voice-related debug messages or major lifecycle logs to keep output readable
  if (msg.includes('voice') || msg.includes('Voice') || msg.includes('SESSION') || msg.includes('heartbeat')) {
    console.log(`[discord-debug] ${msg}`);
  }
});

client.login(process.env.DISCORD_TOKEN);
