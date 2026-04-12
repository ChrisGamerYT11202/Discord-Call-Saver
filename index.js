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

// ---------- JOIN VOICE ----------
async function joinVoice(message, channelId) {
    const channel = message.guild.channels.cache.get(channelId);

    if (!channel) return "❌ Channel not found";
    if (channel.type !== 2) return "❌ That is not a voice channel";

    connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: message.guild.id,
        adapterCreator: message.guild.voiceAdapterCreator
    });

    return `🎧 Joined ${channel.name}`;
}

// ---------- LEAVE VOICE ----------
function leaveVoice() {
    if (!connection) return "❌ Not in voice";
    connection.destroy();
    connection = null;
    return "👋 Left voice";
}

// ---------- MESSAGE HANDLER ----------
console.log("GOT MESSAGE:", message.content);

client.on('messageCreate', async (message) => {
    if (!message.guild || message.author.bot) return;
    if (!message.content.startsWith(PREFIX)) return;

    const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
    const cmd = args.shift()?.toLowerCase();

    // !join <channelId>
    if (cmd === "join") {
        const id = args[0];
        if (!id) return message.reply("Usage: !join CHANNEL_ID");

        const result = await joinVoice(message, id);
        return message.reply(result);
    }

    // !leave
    if (cmd === "leave") {
        return message.reply(leaveVoice());
    }

    // !help
    if (cmd === "help") {
        return message.reply("Commands: !join, !leave");
    }
});

// ---------- READY ----------
client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);
});

// ---------- LOGIN ----------
client.login(TOKEN);

// ---------- EXPRESS (Render PORT FIX) ----------
const PORT = process.env.PORT;

app.get('/', (req, res) => {
    res.send('Bot is alive');
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Web server running on port ${PORT}`);
});
