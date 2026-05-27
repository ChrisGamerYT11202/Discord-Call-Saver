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

// per guild state (IMPORTANT FIX)
const guildState = new Map();

function getState(guildId) {
    if (!guildState.has(guildId)) {
        guildState.set(guildId, {
            channelId: null,
            manualLeave: false
        });
    }
    return guildState.get(guildId);
}

/* =========================
   JOIN
========================= */
async function joinVoice(guild, channelId) {
    if (!guild || !channelId) return "❌ Invalid guild/channel";

    const state = getState(guild.id);

    const channel = guild.channels.cache.get(channelId);
    if (!channel) return "❌ Voice channel not found";

    try {
        joinVoiceChannel({
            channelId: channel.id,
            guildId: guild.id,
            adapterCreator: guild.voiceAdapterCreator,
            selfDeaf: false
        });

        state.channelId = channel.id;
        state.manualLeave = false;

        return `🎧 Joined ${channel.name}`;
    } catch (err) {
        console.error(err);
        return "❌ Failed to join voice";
    }
}

/* =========================
   LEAVE (SAFE FIXED)
========================= */
function leaveVoice(guild) {
    if (!guild) return "❌ Invalid guild";

    const state = getState(guild.id);
    const conn = getVoiceConnection(guild.id);

    // FIX: allow leaving even after restart state mismatch
    state.manualLeave = true;

    if (!conn) {
        state.channelId = null;
        return "❌ Bot was not in voice (state cleaned)";
    }

    try {
        conn.destroy();
    } catch (e) {
        console.error(e);
    }

    state.channelId = null;

    return "👋 Left voice (rejoin disabled)";
}

/* =========================
   TTS FIXED
========================= */
async function tts(guild, text) {
    const conn = getVoiceConnection(guild?.id);
    if (!conn) return "❌ Not in voice";

    const filePath = `tts-${guild.id}.mp3`;

    return new Promise((resolve) => {
        const gtts = new gTTS(text, "en");

        gtts.save(filePath, (err) => {
            if (err) {
                console.error(err);
                return resolve("❌ TTS failed");
            }

            try {
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
            } catch (e) {
                console.error(e);
                resolve("❌ Playback error");
            }
        });
    });
}

/* =========================
   AUTO RECONNECT (FIXED LOGIC)
========================= */
client.on('voiceStateUpdate', (oldState, newState) => {
    if (!client.user) return;
    if (oldState.id !== client.user.id) return;

    const guild = oldState.guild;
    const state = getState(guild.id);

    // 🔒 IMPORTANT: block ALL reconnect if manual leave
    if (state.manualLeave) return;

    // disconnected
    if (!newState.channelId) {
        setTimeout(() => {
            const freshState = getState(guild.id);

            if (freshState.manualLeave) return;
            if (!freshState.channelId) return;

            const channel = guild.channels.cache.get(freshState.channelId);
            if (!channel) return;

            joinVoice(guild, freshState.channelId);
        }, 3000);
    }
});

/* =========================
   PREFIX COMMANDS
========================= */
client.on('messageCreate', async (message) => {
    if (!message.guild) return;
    if (message.author.bot) return;
    if (!message.content.startsWith(PREFIX)) return;

    const args = message.content.slice(1).trim().split(/\s+/);
    const cmd = args.shift()?.toLowerCase();

    if (cmd === "join") {
        const vc = message.member?.voice?.channel;
        if (!vc) return message.reply("❌ You're not in a voice channel");

        const res = await joinVoice(message.guild, vc.id);
        return message.reply(res);
    }

    if (cmd === "leave") {
        return message.reply(leaveVoice(message.guild));
    }

    if (cmd === "tts") {
        const text = args.join(" ");
        if (!text) return message.reply("Usage: !tts text");
        return message.reply(await tts(message.guild, text));
    }
});

/* =========================
   SLASH COMMANDS
========================= */
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (!interaction.guild) {
        return interaction.reply("❌ Must be used in a server");
    }

    try {
        if (interaction.commandName === "join") {
            await interaction.deferReply();

            const vc = interaction.member?.voice?.channel;
            if (!vc) return interaction.editReply("❌ You're not in a voice channel");

            return interaction.editReply(await joinVoice(interaction.guild, vc.id));
        }

        if (interaction.commandName === "leave") {
            await interaction.deferReply();
            return interaction.editReply(leaveVoice(interaction.guild));
        }

        if (interaction.commandName === "tts") {
            await interaction.deferReply();

            const text = interaction.options.getString("text");
            return interaction.editReply(await tts(interaction.guild, text));
        }

    } catch (err) {
        console.error(err);

        try {
            if (interaction.deferred) {
                return interaction.editReply("❌ Error occurred");
            }
        } catch {}
    }
});

/* =========================
   SLASH REGISTER
========================= */
async function registerCommands() {
    const rest = new REST({ version: "10" }).setToken(TOKEN);

    const commands = [
        new SlashCommandBuilder().setName("join").setDescription("Join voice"),
        new SlashCommandBuilder().setName("leave").setDescription("Leave voice"),
        new SlashCommandBuilder()
            .setName("tts")
            .setDescription("Speak text")
            .addStringOption(o =>
                o.setName("text")
                    .setDescription("Text")
                    .setRequired(true)
            )
    ].map(c => c.toJSON());

    await rest.put(
        Routes.applicationCommands(CLIENT_ID),
        { body: commands }
    );

    console.log("⚡ Slash commands registered");
}

/* =========================
   READY
========================= */
client.once('ready', async () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    await registerCommands();
});

/* =========================
   LOGIN + SERVER
========================= */
client.login(TOKEN);

const app = express();

app.get("/", (_, res) => res.send("Bot alive"));

app.listen(process.env.PORT || 3000, () => {
    console.log("🌐 Server running");
});
