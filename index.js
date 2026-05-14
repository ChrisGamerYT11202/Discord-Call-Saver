require('dotenv').config();

const {
    Client,
    GatewayIntentBits,
    Partials,
    ChannelType,
    REST,
    Routes,
    SlashCommandBuilder
} = require('discord.js');

const {
    joinVoiceChannel,
    getVoiceConnection,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus
} = require('@discordjs/voice');

const googleTTS = require('google-tts-api');
const play = require('play-dl');
const express = require('express');

const TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID; // IMPORTANT for slash commands

const PREFIXES = ['!', '?', '/'];

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates
    ],
    partials: [Partials.Channel]
});

const player = createAudioPlayer();

let lastGuildId = null;
let lastChannelId = null;

// =========================
// VOICE JOIN
// =========================
async function joinVoice(guild, channelId) {
    const channel = guild.channels.cache.get(channelId);
    if (!channel) return "Channel not found";

    const connection = joinVoiceChannel({
        channelId,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: false
    });

    connection.subscribe(player);

    lastGuildId = guild.id;
    lastChannelId = channelId;

    console.log("🎧 Joined:", channel.name);
    return "🎧 Joined voice";
}

// =========================
// LEAVE
// =========================
function leaveVoice(guild) {
    const conn = getVoiceConnection(guild.id);
    if (!conn) return "Not in voice";

    conn.destroy();
    return "👋 Left voice";
}

// =========================
// TTS
// =========================
async function speak(text, guild) {
    const conn = getVoiceConnection(guild.id);
    if (!conn) return "Not in voice";

    const url = googleTTS.getAudioUrl(text, {
        lang: 'en',
        slow: false
    });

    const stream = await play.stream(url);
    const resource = createAudioResource(stream.stream, {
        inputType: stream.type
    });

    player.play(resource);

    return `🔊 Speaking: ${text}`;
}

// =========================
// AUTO RECONNECT (EVENT)
// =========================
client.on('voiceStateUpdate', async (oldState, newState) => {
    if (!client.user) return;

    if (
        oldState.id === client.user.id &&
        !newState.channelId
    ) {
        console.log("⚠️ Disconnected → retrying...");

        setTimeout(async () => {
            const guild = client.guilds.cache.get(lastGuildId);
            if (!guild || !lastChannelId) return;

            await joinVoice(guild, lastChannelId);
        }, 2000);
    }
});

// =========================
// BACKUP CHECK (EVERY 5 MIN)
// =========================
setInterval(async () => {
    const guild = client.guilds.cache.get(lastGuildId);
    if (!guild || !lastChannelId) return;

    const conn = getVoiceConnection(guild.id);

    if (!conn) {
        console.log("♻️ 5-min reconnect triggered");
        await joinVoice(guild, lastChannelId);
    }
}, 5 * 60 * 1000);

// =========================
// PREFIX HANDLER (! / ?)
// =========================
client.on('messageCreate', async message => {
    if (!message.guild || message.author.bot) return;

    const prefixUsed = PREFIXES.find(p => message.content.startsWith(p));
    if (!prefixUsed) return;

    const args = message.content.slice(prefixUsed.length).trim().split(/\s+/);
    const cmd = args.shift()?.toLowerCase();

    // JOIN
    if (cmd === 'join') {
        const id = args[0];
        if (!id) return message.reply('Usage: !join CHANNEL_ID');
        return message.reply(await joinVoice(message.guild, id));
    }

    // LEAVE
    if (cmd === 'leave') {
        return message.reply(leaveVoice(message.guild));
    }

    // TTS
    if (cmd === 'tts') {
        const text = args.join(' ');
        if (!text) return message.reply('Usage: !tts hello');
        return message.reply(await speak(text, message.guild));
    }

    if (cmd === 'help') {
        return message.reply(
            `Commands:
!join <id>
!leave
!tts <text>`
        );
    }
});

// =========================
// SLASH COMMANDS
// =========================
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'join') {
        const id = interaction.options.getString('channel');
        return interaction.reply(await joinVoice(interaction.guild, id));
    }

    if (interaction.commandName === 'leave') {
        return interaction.reply(leaveVoice(interaction.guild));
    }

    if (interaction.commandName === 'tts') {
        const text = interaction.options.getString('text');
        return interaction.reply(await speak(text, interaction.guild));
    }
});

// =========================
// READY
// =========================
client.once('clientReady', async () => {
    console.log("✅ Logged in:", client.user.tag);

    const guild = client.guilds.cache.first();
    if (!guild) return;

    const defaultChannel = "1429538224966992013";
    await joinVoice(guild, defaultChannel);
});

// =========================
// SLASH REGISTER (AUTO)
// =========================
async function registerCommands() {
    if (!CLIENT_ID) return;

    const commands = [
        new SlashCommandBuilder()
            .setName('join')
            .setDescription('Join a voice channel')
            .addStringOption(opt =>
                opt.setName('channel')
                    .setDescription('Channel ID')
                    .setRequired(true)
            ),

        new SlashCommandBuilder()
            .setName('leave')
            .setDescription('Leave voice'),

        new SlashCommandBuilder()
            .setName('tts')
            .setDescription('Speak text')
            .addStringOption(opt =>
                opt.setName('text')
                    .setDescription('Text to speak')
                    .setRequired(true)
            )
    ].map(c => c.toJSON());

    const rest = new REST({ version: '10' }).setToken(TOKEN);

    await rest.put(
        Routes.applicationCommands(CLIENT_ID),
        { body: commands }
    );

    console.log("⚡ Slash commands registered");
}

// =========================
// EXPRESS (Render keep alive)
// =========================
const app = express();

app.get('/', (_, res) => res.send("Bot alive"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () =>
    console.log("🌐 Web server on", PORT)
);

// =========================
// START
// =========================
client.login(TOKEN);
registerCommands();
