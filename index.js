require('dotenv').config();

const { Client, GatewayIntentBits } = require('discord.js');
const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus
} = require('@discordjs/voice');
const googleTTS = require('google-tts-api').default;
const readline = require('readline');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates
    ]
});

const player = createAudioPlayer();
let voiceConnection;

client.once('clientReady', () => {
    console.log(`Logged in as ${client.user.tag}`);

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    rl.on('line', async (line) => {
        const args = line.split(" ");
        const command = args.shift().toLowerCase();

        const guild = client.guilds.cache.first();
        if (!guild) return console.log("No guild found");

        try {
            // =====================
            // JOIN VOICE
            // =====================
            if (command === "join") {
                const channelId = args[0];
                if (!channelId) return console.log("Usage: join CHANNEL_ID");

                const channel = guild.channels.cache.get(channelId);
                if (!channel) return console.log("Channel not found");

                voiceConnection = joinVoiceChannel({
                    channelId: channel.id,
                    guildId: guild.id,
                    adapterCreator: guild.voiceAdapterCreator,
                    selfDeaf: false,
                    selfMute: false
                });

                voiceConnection.subscribe(player);

                console.log("✅ Joined voice channel");
            }

            // =====================
            // LEAVE VOICE
            // =====================
            else if (command === "leave") {
                if (!voiceConnection) return console.log("Not in a voice channel!");
                voiceConnection.destroy();
                voiceConnection = null;
                console.log("❌ Left voice channel");
            }

            // =====================
            // TTS
            // =====================
            else if (command === "tts") {
                if (!voiceConnection) return console.log("Not in a voice channel!");
                const text = args.join(" ");
                if (!text) return console.log("Usage: tts TEXT");

                const url = googleTTS.getAudioUrl(text, {
                    lang: 'en',
                    slow: false
                });

                const resource = createAudioResource(url);
                player.play(resource);
                voiceConnection.subscribe(player);

                console.log(`🔊 TTS: ${text}`);
            }

            // =====================
            // UNDEAFEN SELF
            // =====================
            else if (command === "undeafen") {
                const me = guild.members.me;
                await me.voice.setDeaf(false);
                console.log("🔊 Bot undeafened itself");
            }

            // =====================
            // DEAFEN SELF
            // =====================
            else if (command === "deafen") {
                const me = guild.members.me;
                await me.voice.setDeaf(true);
                console.log("🔇 Bot deafened itself");
            }

            // =====================
            // MUTE SELF
            // =====================
            else if (command === "mute") {
                const me = guild.members.me;
                await me.voice.setMute(true);
                console.log("🔇 Bot muted itself");
            }

            // =====================
            // UNMUTE SELF
            // =====================
            else if (command === "unmute") {
                const me = guild.members.me;
                await me.voice.setMute(false);
                console.log("🎤 Bot unmuted itself");
            }

            else {
                console.log("Unknown command");
            }
        } catch (err) {
            console.log("Error executing command:", err);
        }
    });
});

client.login(process.env.BOT_TOKEN);