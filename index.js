require('dotenv').config();

const {
    Client,
    GatewayIntentBits,
    Partials,
    REST,
    Routes,
    SlashCommandBuilder
} = require('discord.js');

const {
    joinVoiceChannel,
    getVoiceConnection,
    createAudioPlayer,
    createAudioResource
} = require('@discordjs/voice');

const express = require('express');
const https = require("https");

const TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const PREFIX = "!";

if (!TOKEN) throw new Error("Missing BOT_TOKEN");
if (!CLIENT_ID) throw new Error("Missing CLIENT_ID");

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

// =======================
// VOICE JOIN
// =======================
async function joinVoice(guild, channelId) {
    const channel = guild.channels.cache.get(channelId);
    if (!channel) return "❌ Channel not found";

    joinVoiceChannel({
        channelId: channel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: false
    });

    lastGuildId = guild.id;
    lastChannelId = channel.id;

    console.log(`🎧 Joined ${channel.name}`);

    return `🎧 Joined ${channel.name}`;
}

// =======================
// LEAVE
// =======================
function leaveVoice(guild) {
    const conn = getVoiceConnection(guild.id);
    if (!conn) return "❌ Not in voice";

    conn.destroy();
    return "👋 Left voice";
}

// =======================
// TTS (FIXED + SAFE)
// =======================
function streamFromUrl(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => resolve(res)).on("error", reject);
    });
}

async function tts(text) {
    const guild = client.guilds.cache.get(lastGuildId);
    if (!guild) return "Not in guild";

    const connection = getVoiceConnection(guild.id);
    if (!connection) return "Not in voice";

    const url =
        `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=en&client=tw-ob`;

    const stream = await streamFromUrl(url);

    const resource = createAudioResource(stream);

    player.play(resource);
    connection.subscribe(player);

    return `🔊 Speaking: ${text}`;
}

// =======================
// AUTO RECONNECT
// =======================
client.on('voiceStateUpdate', async (oldState, newState) => {
    if (oldState.id !== client.user.id) return;

    if (!newState.channelId) {
        console.log("⚠️ Disconnected → rejoining...");

        setTimeout(async () => {
            const guild = client.guilds.cache.get(lastGuildId);
            if (!guild || !lastChannelId) return;

            await joinVoice(guild, lastChannelId);
        }, 2000);
    }
});

// =======================
// BACKUP CHECK
// =======================
setInterval(async () => {
    if (!lastGuildId || !lastChannelId) return;

    const guild = client.guilds.cache.get(lastGuildId);
    if (!guild) return;

    const conn = getVoiceConnection(guild.id);

    if (!conn) {
        console.log("♻️ Backup reconnect triggered");
        await joinVoice(guild, lastChannelId);
    }
}, 5 * 60 * 1000);

// =======================
// PREFIX COMMANDS
// =======================
client.on('messageCreate', async (message) => {
    if (!message.guild || message.author.bot) return;
    if (!message.content.startsWith(PREFIX)) return;

    const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
    const cmd = args.shift()?.toLowerCase();

    if (cmd === "join") {
        const id = args[0];
        return message.reply(await joinVoice(message.guild, id));
    }

    if (cmd === "leave") {
        return message.reply(leaveVoice(message.guild));
    }

    if (cmd === "tts") {
        const text = args.join(" ");
        if (!text) return message.reply("Usage: !tts text");
        return message.reply(await tts(text));
    }

    if (cmd === "help") {
        return message.reply("Commands: !join !leave !tts | /join /leave /tts");
    }
});

// =======================
// SLASH COMMANDS REGISTER
// =======================
async function registerCommands() {
    const rest = new REST({ version: "10" }).setToken(TOKEN);

    const commands = [
        new SlashCommandBuilder()
            .setName("join")
            .setDescription("Join voice")
            .addStringOption(opt =>
                opt.setName("channel")
                    .setDescription("Channel ID")
                    .setRequired(true)
            ),

        new SlashCommandBuilder()
            .setName("leave")
            .setDescription("Leave voice"),

        new SlashCommandBuilder()
            .setName("tts")
            .setDescription("Speak text")
            .addStringOption(opt =>
                opt.setName("text")
                    .setDescription("Text")
                    .setRequired(true)
            )
    ].map(c => c.toJSON());

    const guild = client.guilds.cache.first();
    if (!guild) return;

    await rest.put(
        Routes.applicationGuildCommands(CLIENT_ID, guild.id),
        { body: commands }
    );

    console.log("⚡ Slash commands registered");
}

// =======================
// SLASH HANDLER (FIXED)
// =======================
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    try {
        if (interaction.commandName === "join") {
            await interaction.deferReply();

            const res = await joinVoice(
                interaction.guild,
                interaction.options.getString("channel")
            );

            return interaction.editReply(res);
        }

        if (interaction.commandName === "leave") {
            await interaction.deferReply();

            const res = leaveVoice(interaction.guild);

            return interaction.editReply(res);
        }

        if (interaction.commandName === "tts") {
            await interaction.deferReply();

            const text = interaction.options.getString("text");

            const res = await tts(text);

            return interaction.editReply(res);
        }

    } catch (err) {
        console.error(err);

        try {
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply("❌ Error occurred");
            } else {
                await interaction.reply({ content: "❌ Error occurred", ephemeral: true });
            }
        } catch {}
    }
});

// =======================
// READY
// =======================
client.once('clientReady', async () => {
    console.log(`✅ Logged in as ${client.user.tag}`);

    await registerCommands();

    const guild = client.guilds.cache.first();
    if (!guild) return;

    const defaultChannel = "1429538224966992013";

    await joinVoice(guild, defaultChannel);
});

// =======================
// LOGIN
// =======================
client.login(TOKEN);

// =======================
// EXPRESS SERVER (RENDER FIX)
// =======================
const app = express();

app.get("/", (_, res) => res.send("Bot alive"));

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
    console.log("🌐 Web server running on port", PORT);
});
