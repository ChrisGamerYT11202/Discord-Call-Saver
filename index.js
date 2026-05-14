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
    createAudioResource,
    AudioPlayerStatus,
    StreamType
} = require('@discordjs/voice');

const express = require('express');
const gTTS = require('gtts');
const fs = require('fs');

const TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

const PREFIX = "!";

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

// 🔒 THIS PREVENTS AUTO REJOIN AFTER /LEAVE
let manualLeave = false;

// =======================
// JOIN VOICE
// =======================
async function joinVoice(guild, channelId) {
    if (manualLeave) return "🚪 Bot is in leave mode (use !join or /join to re-enable)";

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
// LEAVE (LOCKED)
// =======================
function leaveVoice(guild) {
    const conn = getVoiceConnection(guild.id);
    if (!conn) return "❌ Not in voice";

    manualLeave = true; // 🔒 STOP AUTO REJOIN

    conn.destroy();

    console.log("🚪 Left voice (manual lock enabled)");

    return "👋 Left voice (rejoin disabled)";
}

// =======================
// UNLOCK REJOIN
// =======================
function unlockRejoin() {
    manualLeave = false;
}

// =======================
// RELIABLE TTS (MP3 FILE METHOD)
// =======================
async function tts(text) {
    const guild = client.guilds.cache.get(lastGuildId);
    if (!guild) return "Not in guild";

    const conn = getVoiceConnection(guild.id);
    if (!conn) return "Not in voice";

    const filePath = `tts.mp3`;

    return new Promise((resolve, reject) => {
        const gtts = new gTTS(text, "en");

        gtts.save(filePath, async (err) => {
            if (err) {
                console.error(err);
                return resolve("❌ TTS failed");
            }

            const resource = createAudioResource(fs.createReadStream(filePath), {
                inputType: StreamType.Arbitrary
            });

            player.play(resource);
            conn.subscribe(player);

            player.once(AudioPlayerStatus.Idle, () => {
                try {
                    fs.unlinkSync(filePath);
                } catch {}
            });

            resolve(`🔊 Speaking: ${text}`);
        });
    });
}

// =======================
// AUTO RECONNECT (DISABLED WHEN LEFT)
// =======================
client.on('voiceStateUpdate', async (oldState, newState) => {
    if (manualLeave) return; // 🚪 STOP EVERYTHING

    if (oldState.id !== client.user.id) return;

    if (!newState.channelId) {
        console.log("⚠️ Disconnected → rejoining...");

        setTimeout(async () => {
            const guild = client.guilds.cache.get(lastGuildId);
            if (!guild || !lastChannelId) return;

            await joinVoice(guild, lastChannelId);
        }, 3000);
    }
});

// =======================
// BACKUP CHECK
// =======================
setInterval(async () => {
    if (manualLeave) return;

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

    const args = message.content.slice(1).trim().split(/\s+/);
    const cmd = args.shift()?.toLowerCase();

    if (cmd === "join") {
        unlockRejoin();
        return message.reply(await joinVoice(message.guild, args[0]));
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
// SLASH COMMANDS
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
// INTERACTIONS (FIXED SAFE)
// =======================
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    try {
        if (interaction.commandName === "join") {
            unlockRejoin();
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
            if (interaction.deferred) {
                return interaction.editReply("❌ Error");
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

    await joinVoice(guild, "1429538224966992013");
});

// =======================
// LOGIN
// =======================
client.login(TOKEN);

// =======================
// RENDER SERVER
// =======================
const app = express();

app.get("/", (_, res) => res.send("Bot alive"));

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
    console.log("🌐 Web server running on port", PORT);
});
