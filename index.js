require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder
} = require('discord.js');

const {
  joinVoiceChannel,
  getVoiceConnection,
  VoiceConnectionStatus,
  entersState,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus
} = require('@discordjs/voice');

const gTTS = require('gtts');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

const PREFIX = '!';
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates
  ]
});

const player = createAudioPlayer();

const state = new Map(); // per guild state

function getState(guildId) {
  if (!state.has(guildId)) {
    state.set(guildId, {
      channelId: null,
      manualLeave: false
    });
  }
  return state.get(guildId);
}

function isInGuild(interaction) {
  return interaction && interaction.guildId && interaction.guild;
}

/* ---------------- JOIN ---------------- */

async function join(guild, channelId) {
  const s = getState(guild.id);
  s.channelId = channelId;
  s.manualLeave = false;

  const connection = joinVoiceChannel({
    channelId,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false
  });

  connection.subscribe(player);

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 10_000);
  } catch {
    return '❌ Failed to join voice';
  }

  return `🎧 Joined voice`;
}

/* ---------------- LEAVE ---------------- */

function leave(guild) {
  const conn = getVoiceConnection(guild.id);
  const s = getState(guild.id);

  s.manualLeave = true;
  s.channelId = null;

  if (!conn) return '❌ Not in voice';

  conn.destroy();
  return '👋 Left voice';
}

/* ---------------- TTS ---------------- */

async function tts(guild, text) {
  const conn = getVoiceConnection(guild.id);
  if (!conn) return '❌ Not in voice';

  const file = path.join(__dirname, `tts-${Date.now()}.mp3`);

  return new Promise((resolve) => {
    const gtts = new gTTS(text, 'en');

    gtts.save(file, () => {
      const resource = createAudioResource(fs.createReadStream(file));
      player.play(resource);

      player.once(AudioPlayerStatus.Idle, () => {
        fs.unlinkSync(file);
      });

      resolve(`🔊 Speaking: ${text}`);
    });
  });
}

/* ---------------- SLASH COMMANDS ---------------- */

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder().setName('join').setDescription('Join voice'),
    new SlashCommandBuilder().setName('leave').setDescription('Leave voice'),
    new SlashCommandBuilder()
      .setName('tts')
      .setDescription('Speak text')
      .addStringOption(opt =>
        opt.setName('text').setDescription('Text').setRequired(true)
      )
  ].map(c => c.toJSON());

  const rest = new REST({ version: '10' }).setToken(TOKEN);

  // 🔥 IMPORTANT: guild commands = instant update (fixes "outdated")
  for (const guild of client.guilds.cache.values()) {
    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, guild.id),
      { body: commands }
    );
  }

  console.log('✅ Commands registered (guild scoped)');
}

/* ---------------- EVENTS ---------------- */

client.on('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands();
});

client.on('messageCreate', async (msg) => {
  if (!msg.guild || msg.author.bot) return;

  const args = msg.content.slice(PREFIX.length).trim().split(/\s+/);
  const cmd = args.shift()?.toLowerCase();

  if (cmd === 'join') {
    const vc = msg.member?.voice?.channel;
    if (!vc) return msg.reply('❌ Join a voice channel first');
    return msg.reply(await join(msg.guild, vc.id));
  }

  if (cmd === 'leave') {
    return msg.reply(leave(msg.guild));
  }

  if (cmd === 'tts') {
    return msg.reply(await tts(msg.guild, args.join(' ')));
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // 🔥 THIS FIXES YOUR ERROR
  if (!interaction.inGuild()) {
    return interaction.reply({
      content: '❌ This command only works in a server',
      ephemeral: true
    });
  }

  const guild = interaction.guild;

  if (interaction.commandName === 'join') {
    const vc = interaction.member.voice.channel;
    if (!vc) return interaction.reply('❌ Join a voice channel first');

    return interaction.reply(await join(guild, vc.id));
  }

  if (interaction.commandName === 'leave') {
    return interaction.reply(leave(guild));
  }

  if (interaction.commandName === 'tts') {
    const text = interaction.options.getString('text');
    return interaction.reply(await tts(guild, text));
  }
});

/* ---------------- LOGIN ---------------- */

client.login(TOKEN);
