require('dotenv').config();

const express = require("express");
const { Client, GatewayIntentBits } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, VoiceConnectionStatus, entersState } = require('@discordjs/voice');
const googleTTS = require('google-tts-api').default;

// =========================
// KEEP RENDER ALIVE
// =========================
const app = express();
const PORT = process.env.PORT || 3000;
app.get("/", (req, res) => res.send("Bot is alive"));
app.listen(PORT, () => console.log(`🌐 Web server running on port ${PORT}`));

// =========================
// DISCORD BOT SETUP
// =========================
const CHANNEL_ID = "1429538224966992013"; // your voice channel
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const player = createAudioPlayer();
let connection;

// =========================
// JOIN VOICE FOREVER
// =========================
async function connectToVoice(guild) {
    try {
        console.log("Joining voice...");

        connection = joinVoiceChannel({
            channelId: CHANNEL_ID,
            guildId: guild.id,
            adapterCreator: guild.voiceAdapterCreator,
            selfDeaf: false
        });

        connection.subscribe(player);

        connection.on(VoiceConnectionStatus.Disconnected, async () => {
            console.log("Disconnected... reconnecting");
            try {
                await Promise.race([
                    entersState(connection, VoiceConnectionStatus.Signalling, 5000),
                    entersState(connection, VoiceConnectionStatus.Connecting, 5000),
                ]);
            } catch {
                console.log("Rejoining voice...");
                connectToVoice(guild);
            }
        });

        console.log("✅ Bot is now ALWAYS in voice");
    } catch (err) {
        console.log("Voice error:", err);
        setTimeout(() => connectToVoice(guild), 5000);
    }
}

// =========================
// READY EVENT
// =========================
client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    const guild = client.guilds.cache.first();
    if (!guild) return console.log("No guild found");
    connectToVoice(guild);
});

// =========================
// TTS COMMAND
// =========================
client.on('messageCreate', async message => {
    if (!message.content.startsWith("!tts")) return;

    const text = message.content.replace("!tts", "").trim();
    if (!text) return;

    const url = googleTTS.getAudioUrl(text, { lang: 'en', slow: false });
    const resource = createAudioResource(url);
    player.play(resource);
});

client.login(process.env.BOT_TOKEN);
