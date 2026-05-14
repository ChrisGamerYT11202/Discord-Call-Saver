require('dotenv').config();

const {
    Client,
    GatewayIntentBits,
    Partials,
    ChannelType
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

// ============================
// VOICE STATE MEMORY
// ============================

let connection = null;
let lastVoiceChannelId = null;
let lastGuildId = null;

// ============================
// JOIN VOICE
// ============================

async function joinVoice(messageOrGuild, channelId) {

    const guild =
        messageOrGuild.guild ??
        messageOrGuild;

    const channel = guild.channels.cache.get(channelId);

    if (!channel)
        return "❌ Channel not found";

    if (channel.type !== ChannelType.GuildVoice)
        return "❌ Not a voice channel";

    connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: false
    });

    // remember channel
    lastVoiceChannelId = channel.id;
    lastGuildId = guild.id;

    console.log(`🎧 Joined ${channel.name}`);

    return `🎧 Joined ${channel.name}`;
}

// ============================
// LEAVE VOICE
// ============================

function leaveVoice() {
    if (!connection) return "❌ Not in voice";

    connection.destroy();
    connection = null;

    console.log("👋 Left voice");

    return "👋 Left voice";
}

// ============================
// COMMAND HANDLER
// ============================

client.on('messageCreate', async (message) => {

    if (!message.guild || message.author.bot) return;
    if (!message.content.startsWith(PREFIX)) return;

    console.log("📩 Command received:", message.content);

    const args = message.content
        .slice(PREFIX.length)
        .trim()
        .split(/\s+/);

    const cmd = args.shift()?.toLowerCase();

    // JOIN
    if (cmd === "join") {
        const id = args[0];
        if (!id)
            return message.reply("Usage: !join CHANNEL_ID");

        const result = await joinVoice(message, id);
        return message.reply(result);
    }

    // LEAVE
    if (cmd === "leave") {
        return message.reply(leaveVoice());
    }

    // HELP
    if (cmd === "help") {
        return message.reply(
            "Commands:\n" +
            "`!join CHANNEL_ID` - join VC\n" +
            "`!leave` - leave VC"
        );
    }
});

// ============================
// AUTO JOIN ON STARTUP
// ============================

client.once('clientReady', async () => {

    console.log(`Logged in as ${client.user.tag}`);

    const guild = client.guilds.cache.first();
    if (!guild) return;

    const channelId = "1429538224966992013";

    const channel = guild.channels.cache.get(channelId);
    if (!channel) {
        console.log("Voice channel not found");
        return;
    }

    await joinVoice(guild, channelId);

    console.log("🎧 Auto joined voice");
});

// ============================
// DETECT DISCONNECT
// ============================

client.on('voiceStateUpdate', (oldState, newState) => {

    if (!client.user) return;

    // bot got disconnected
    if (
        oldState.member?.id === client.user.id &&
        !newState.channelId
    ) {
        console.log("⚠️ Bot disconnected from voice");
        connection = null;
    }
});

// ============================
// AUTO REJOIN LOOP
// ============================

setInterval(async () => {

    try {

        if (!lastVoiceChannelId || !lastGuildId)
            return;

        if (connection &&
            connection.state.status !== "destroyed")
            return;

        console.log("🔎 Checking voice connection...");

        const guild =
            client.guilds.cache.get(lastGuildId);

        if (!guild) return;

        const channel =
            guild.channels.cache.get(lastVoiceChannelId);

        if (!channel) return;

        console.log("♻️ Rejoining voice channel...");

        await joinVoice(guild, lastVoiceChannelId);

    } catch (err) {
        console.log("Auto-rejoin error:", err);
    }

}, 5 * 60 * 1000); // every 5 minutes

// ============================
// LOGIN
// ============================

client.login(TOKEN);

// ============================
// RENDER PORT FIX
// ============================

const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('Bot is alive');
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Web server running on port ${PORT}`);
});
