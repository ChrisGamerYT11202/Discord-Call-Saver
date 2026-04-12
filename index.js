require('dotenv').config();

const PORT = process.env.PORT || 3000;

const {
    Client,
    GatewayIntentBits,
    Partials,
    ChannelType
} = require('discord.js');

const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus
} = require('@discordjs/voice');

const googleTTS = require('google-tts-api');

const TOKEN = process.env.BOT_TOKEN;
const PREFIX = '!';

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
let connection = null;

// ---------- VOICE ----------
async function joinVoice(channel) {
    connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator
    });

    connection.subscribe(player);
    return `Joined ${channel.name}`;
}

function leaveVoice() {
    if (!connection) return 'Not in voice.';
    connection.destroy();
    connection = null;
    return 'Left voice.';
}

// ---------- TTS ----------
async function tts(text) {
    if (!connection) return 'Not in voice. Use !join first.';

    const url = googleTTS.getAudioUrl(text, {
        lang: 'en',
        slow: false
    });

    const stream = await play.stream(url);

    const resource = createAudioResource(stream.stream, {
        inputType: stream.type
    });

    player.play(resource);

    player.once(AudioPlayerStatus.Idle, () => {
        // done speaking
    });

    return `Speaking: ${text}`;
}

// ---------- MESSAGE HANDLER ----------
client.on('messageCreate', async (message) => {
    if (!message.guild || message.author.bot) return;
    if (!message.content.startsWith(PREFIX)) return;

    const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
    const cmd = args.shift()?.toLowerCase();

    // JOIN
    if (cmd === 'join') {
        const channelId = args[0];
        if (!channelId) return message.reply('Usage: !join CHANNEL_ID');

        const channel = message.guild.channels.cache.get(channelId);

        if (!channel || channel.type !== ChannelType.GuildVoice) {
            return message.reply('Invalid voice channel.');
        }

        const res = await joinVoice(channel);
        return message.reply(res);
    }

    // LEAVE
    if (cmd === 'leave') {
        return message.reply(leaveVoice());
    }

    // TTS
    if (cmd === 'tts') {
        const text = args.join(' ');
        if (!text) return message.reply('Usage: !tts text');

        const res = await tts(text);
        return message.reply(res);
    }

    return;
});

// ---------- READY ----------
client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);
});

client.login(TOKEN);

const express = require('express');

const app = express();
app.use(express.json());

// ✅ HEALTH CHECK (Render uses this sometimes)
app.get('/', (req, res) => {
    res.status(200).send('Bot is alive');
});

app.get('/health', (req, res) => {
    res.status(200).send('ok');
});

// ✅ IMPORTANT: Render PORT FIX
const PORT = process.env.PORT;

// 🚨 MUST bind to 0.0.0.0 or Render won't detect it
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Web server running on port ${PORT}`);
});
