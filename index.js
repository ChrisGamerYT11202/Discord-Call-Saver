require('dotenv').config();

const {
    Client,
    GatewayIntentBits,
    Partials
} = require('discord.js');

const {
    joinVoiceChannel
} = require('@discordjs/voice');

const express = require('express');
const app = express();
app.use(express.json());

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

let connection = null;

// ---------- VOICE JOIN ----------
async function joinVoice(message, channelId) {
    const channel = message.guild.channels.cache.get(channelId);

    if (!channel) return "❌ Channel not found";
    if (channel.type !== 2) return "❌ Not a voice channel";

    connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: message.guild.id,
        adapterCreator: message.guild.voiceAdapterCreator
    });

    return `🎧 Joined ${channel.name}`;
}

// ---------- LEAVE ----------
function leaveVoice() {
    if (!connection) return "❌ Not in voice";
    connection.destroy();
    connection = null;
    return "👋 Left voice";
}

// ---------- COMMANDS ----------
client.on('messageCreate', async (message) => {
    if (!message.guild || message.author.bot) return;
    if (!message.content.startsWith(PREFIX)) return;

    const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
    const cmd = args.shift()?.toLowerCase();

    if (cmd === "join") {
        const id = args[0];
        if (!id) return message.reply("Usage: !join CHANNEL_ID");

        const result = await joinVoice(message, id);
        return message.reply(result);
    }

    if (cmd === "leave") {
        return message.reply(leaveVoice());
    }

    if (cmd === "help") {
        return message.reply("Commands: !join, !leave");
    }
});

// ---------- READY ----------
client.once('clientReady', async () => {
    console.log(`Logged in as ${client.user.tag}`);

    const guild = client.guilds.cache.first();
    if (!guild) return console.log("No guild found");

    const channel = guild.channels.cache.get("1429538224966992013");

    if (!channel) {
        console.log("Voice channel not found");
        return;
    }

    joinVoiceChannel({
        channelId: channel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: false
    });

    console.log("🎧 Auto joined voice");
});

// ---------- LOGIN ----------
client.login(TOKEN);

// ---------- EXPRESS (Render port fix) ----------
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('Bot is alive');
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Web server running on port ${PORT}`);
});
