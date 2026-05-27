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

// store per-guild voice data
const guildVoiceData = new Map();

// =======================
// GET OR CREATE GUILD DATA
// =======================
function getGuildData(guildId) {
    if (!guildVoiceData.has(guildId)) {
        guildVoiceData.set(guildId, {
            lastChannelId: null,
            manualLeave: false
        });
    }

    return guildVoiceData.get(guildId);
}

// =======================
// JOIN VOICE
// =======================
async function joinVoice(guild, channelId) {

    const data = getGuildData(guild.id);

    const channel = guild.channels.cache.get(channelId);

    if (!channel) {
        return "❌ Channel not found";
    }

    joinVoiceChannel({
        channelId: channel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: false
    });

    data.lastChannelId = channel.id;
    data.manualLeave = false;

    console.log(`🎧 Joined ${channel.name} in ${guild.name}`);

    return `🎧 Joined ${channel.name}`;
}

// =======================
// LEAVE VOICE
// =======================
function leaveVoice(guild) {

    const data = getGuildData(guild.id);

    const conn = getVoiceConnection(guild.id);

    if (!conn) {
        return "❌ Not in voice";
    }

    // disable rejoin
    data.manualLeave = true;

    conn.destroy();

    console.log(`🚪 Left voice in ${guild.name}`);

    return "👋 Left voice (rejoin disabled)";
}

// =======================
// TTS
// =======================
async function tts(guild, text) {

    const conn = getVoiceConnection(guild.id);

    if (!conn) {
        return "❌ Not in voice";
    }

    const filePath = `tts-${guild.id}.mp3`;

    return new Promise((resolve) => {

        const gtts = new gTTS(text, "en");

        gtts.save(filePath, (err) => {

            if (err) {
                console.error(err);
                return resolve("❌ TTS failed");
            }

            const resource = createAudioResource(
                fs.createReadStream(filePath),
                {
                    inputType: StreamType.Arbitrary
                }
            );

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
// AUTO RECONNECT
// =======================
client.on('voiceStateUpdate', async (oldState, newState) => {

    if (oldState.id !== client.user.id) return;

    const guild = oldState.guild;

    const data = getGuildData(guild.id);

    // manually left
    if (data.manualLeave) return;

    // disconnected unexpectedly
    if (!newState.channelId) {

        console.log(`⚠️ Disconnected from ${guild.name}`);

        setTimeout(async () => {

            try {

                if (!data.lastChannelId) return;

                console.log(`♻️ Rejoining ${guild.name}`);

                await joinVoice(
                    guild,
                    data.lastChannelId
                );

            } catch (err) {
                console.error(err);
            }

        }, 3000);
    }
});

// =======================
// BACKUP CHECK
// =======================
setInterval(async () => {

    for (const [guildId, data] of guildVoiceData.entries()) {

        if (data.manualLeave) continue;

        const guild = client.guilds.cache.get(guildId);

        if (!guild) continue;

        const conn = getVoiceConnection(guild.id);

        if (!conn && data.lastChannelId) {

            console.log(`♻️ Backup reconnect for ${guild.name}`);

            try {
                await joinVoice(
                    guild,
                    data.lastChannelId
                );
            } catch {}
        }
    }

}, 5 * 60 * 1000);

// =======================
// PREFIX COMMANDS
// =======================
client.on('messageCreate', async (message) => {

    if (!message.guild) return;
    if (message.author.bot) return;
    if (!message.content.startsWith(PREFIX)) return;

    const args = message.content
        .slice(PREFIX.length)
        .trim()
        .split(/\s+/);

    const cmd = args.shift()?.toLowerCase();

    // JOIN
    if (cmd === "join") {

        const voiceChannel =
            message.member?.voice?.channel;

        if (!voiceChannel) {
            return message.reply(
                "❌ You're not in a voice channel"
            );
        }

        return message.reply(
            await joinVoice(
                message.guild,
                voiceChannel.id
            )
        );
    }

    // LEAVE
    if (cmd === "leave") {

        return message.reply(
            leaveVoice(message.guild)
        );
    }

    // TTS
    if (cmd === "tts") {

        const text = args.join(" ");

        if (!text) {
            return message.reply(
                "Usage: !tts hello"
            );
        }

        return message.reply(
            await tts(message.guild, text)
        );
    }

    // HELP
    if (cmd === "help") {

        return message.reply(
            "Commands: !join !leave !tts | /join /leave /tts"
        );
    }
});

// =======================
// REGISTER SLASH COMMANDS
// =======================
async function registerCommands() {

    const rest = new REST({
        version: "10"
    }).setToken(TOKEN);

    const commands = [

        new SlashCommandBuilder()
            .setName("join")
            .setDescription("Join your voice channel"),

        new SlashCommandBuilder()
            .setName("leave")
            .setDescription("Leave voice"),

        new SlashCommandBuilder()
            .setName("tts")
            .setDescription("Speak text")
            .addStringOption(opt =>
                opt.setName("text")
                    .setDescription("Text to speak")
                    .setRequired(true)
            )

    ].map(c => c.toJSON());

    await rest.put(
        Routes.applicationCommands(CLIENT_ID),
        { body: commands }
    );

    console.log("⚡ Global slash commands registered");
}

// =======================
// SLASH COMMANDS
// =======================
client.on('interactionCreate', async (interaction) => {

    if (!interaction.isChatInputCommand()) return;

    try {

        // JOIN
        if (interaction.commandName === "join") {

            await interaction.deferReply();

            const voiceChannel =
                interaction.member.voice.channel;

            if (!voiceChannel) {

                return interaction.editReply(
                    "❌ You're not in a voice channel"
                );
            }

            const result = await joinVoice(
                interaction.guild,
                voiceChannel.id
            );

            return interaction.editReply(result);
        }

        // LEAVE
        if (interaction.commandName === "leave") {

            await interaction.deferReply();

            return interaction.editReply(
                leaveVoice(interaction.guild)
            );
        }

        // TTS
        if (interaction.commandName === "tts") {

            await interaction.deferReply();

            const text =
                interaction.options.getString("text");

            const result = await tts(
                interaction.guild,
                text
            );

            return interaction.editReply(result);
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
});

// =======================
// LOGIN
// =======================
client.login(TOKEN);

// =======================
// EXPRESS SERVER
// =======================
const app = express();

app.get("/", (_, res) => {
    res.send("Bot alive");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Web server running on port ${PORT}`);
});
