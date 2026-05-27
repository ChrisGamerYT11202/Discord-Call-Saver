require('dotenv').config();

const {
    Client,
    GatewayIntentBits,
    Partials,
    REST,
    Routes,
    SlashCommandBuilder,
    ChannelType
} = require('discord.js');

const {
    joinVoiceChannel,
    getVoiceConnection,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    StreamType,
    VoiceConnectionStatus,
    entersState
} = require('@discordjs/voice');

const express = require('express');
const gTTS = require('gtts');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const PREFIX = '!';
const PORT = Number(process.env.PORT || 3000);
const AUDIO_DIR = path.join(__dirname, 'audio_cache');
const CLEAR_GLOBAL_COMMANDS = process.env.CLEAR_GLOBAL_COMMANDS !== 'false';

const MANUAL_LEAVE_COOLDOWN_MS = 60_000;
const RECONNECT_DEBOUNCE_MS = 10_000;
const WATCHDOG_INTERVAL_MS = 5 * 60 * 1000;
const MAX_RECONNECT_ATTEMPTS = 8;
const MAX_TTS_QUEUE = 25;

if (!TOKEN) throw new Error('Missing BOT_TOKEN');
if (!CLIENT_ID) throw new Error('Missing CLIENT_ID');

if (!fs.existsSync(AUDIO_DIR)) {
    fs.mkdirSync(AUDIO_DIR, { recursive: true });
}

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
const commandREST = new REST({ version: '10' }).setToken(TOKEN);
const guildState = new Map();
const reconnectLocks = new Map();

function now() {
    return Date.now();
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function safeId(value) {
    return String(value || '');
}

function isVoiceChannel(channel) {
    return !!channel && (
        channel.type === ChannelType.GuildVoice ||
        channel.type === ChannelType.GuildStageVoice
    );
}

function getState(guildId) {
    const id = safeId(guildId);
    if (!guildState.has(id)) {
        guildState.set(id, {
            guildId: id,
            channelId: null,
            manualLeave: false,
            manualLeaveUntil: 0,
            lastJoinAt: 0,
            lastLeaveAt: 0,
            lastDisconnectAt: 0,
            lastReconnectAttemptAt: 0,
            reconnectAttempts: 0,
            lastKnownVoiceState: null,
            reconnectLockedUntil: 0,
            pendingJoinReason: null,
            lastError: null,
            ttsQueue: [],
            ttsPlaying: false,
            ttsLock: false,
            createdAt: now(),
            updatedAt: now()
        });
    }
    return guildState.get(id);
}

function touchState(guildId) {
    const state = getState(guildId);
    state.updatedAt = now();
    return state;
}

function lockReconnect(guildId, ms = RECONNECT_DEBOUNCE_MS) {
    const state = getState(guildId);
    state.reconnectLockedUntil = now() + ms;
    reconnectLocks.set(safeId(guildId), state.reconnectLockedUntil);
}

function unlockReconnect(guildId) {
    const state = getState(guildId);
    state.reconnectLockedUntil = 0;
    reconnectLocks.delete(safeId(guildId));
}

function reconnectLocked(guildId) {
    const state = getState(guildId);
    const until = reconnectLocks.get(safeId(guildId)) || state.reconnectLockedUntil || 0;
    return now() < until;
}

function logGuild(guildId, message) {
    const short = safeId(guildId).slice(0, 6);
    console.log(`[${short}] ${message}`);
}

function getGuildById(guildId) {
    return client.guilds.cache.get(safeId(guildId)) || null;
}

async function getBotMember(guild) {
    if (!guild) return null;
    if (guild.members.me) return guild.members.me;
    return guild.members.fetch(client.user.id).catch(() => null);
}

async function getLiveBotVoiceChannelId(guild) {
    if (!guild) return null;

    const conn = getVoiceConnection(guild.id);
    if (conn?.joinConfig?.channelId) {
        return conn.joinConfig.channelId;
    }

    const me = await getBotMember(guild);
    return me?.voice?.channelId || null;
}

async function syncGuildStateFromLiveVoice(guild) {
    const state = getState(guild.id);
    const liveChannelId = await getLiveBotVoiceChannelId(guild);

    if (liveChannelId) {
        state.channelId = liveChannelId;
        state.manualLeave = false;
        state.manualLeaveUntil = 0;
        state.lastKnownVoiceState = 'live-sync';
        touchState(guild.id);
    }

    return liveChannelId;
}

function manualLeaveActive(state) {
    if (!state) return false;
    if (!state.manualLeave) return false;
    if (state.manualLeaveUntil && now() > state.manualLeaveUntil) {
        state.manualLeave = false;
        state.manualLeaveUntil = 0;
        return false;
    }
    return true;
}

function voiceChannelFromMember(member) {
    return member?.voice?.channel || null;
}

function buildAudioPath(guildId) {
    const suffix = crypto.randomBytes(6).toString('hex');
    return path.join(AUDIO_DIR, `tts-${safeId(guildId)}-${suffix}.mp3`);
}

async function waitForReady(connection) {
    try {
        await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
        return true;
    } catch {
        return false;
    }
}

async function disconnectLiveVoice(guild) {
    const conn = getVoiceConnection(guild.id);
    const me = await getBotMember(guild);

    if (conn) {
        try {
            conn.destroy();
            return true;
        } catch {}
    }

    if (me?.voice?.setChannel) {
        try {
            await me.voice.setChannel(null);
            return true;
        } catch {}
    }

    return false;
}

async function joinVoice(guild, channelId, source = 'manual') {
    if (!guild) return '❌ Guild not found';
    if (!channelId) return '❌ Voice channel not found';

    const state = getState(guild.id);
    const channel = guild.channels.cache.get(channelId);

    if (!isVoiceChannel(channel)) {
        return '❌ Voice channel not found';
    }

    const existing = getVoiceConnection(guild.id);
    if (existing) {
        try {
            existing.destroy();
        } catch {}
    }

    state.channelId = channel.id;
    state.manualLeave = false;
    state.manualLeaveUntil = 0;
    state.lastJoinAt = now();
    state.lastError = null;
    state.pendingJoinReason = source;
    state.reconnectAttempts = 0;
    state.lastKnownVoiceState = 'joining';
    touchState(guild.id);

    const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false
    });

    connection.subscribe(player);

    connection.on(VoiceConnectionStatus.Ready, () => {
        const s = getState(guild.id);
        s.lastKnownVoiceState = 'ready';
        s.lastError = null;
        touchState(guild.id);
    });

    connection.on(VoiceConnectionStatus.Destroyed, () => {
        const s = getState(guild.id);
        s.lastKnownVoiceState = 'destroyed';
        touchState(guild.id);
    });

    connection.on('error', (err) => {
        const s = getState(guild.id);
        s.lastKnownVoiceState = 'error';
        s.lastError = err?.message || String(err);
        touchState(guild.id);
        console.error(err);
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
        const s = getState(guild.id);
        s.lastDisconnectAt = now();
        s.lastKnownVoiceState = 'disconnected';
        touchState(guild.id);

        if (manualLeaveActive(s)) {
            logGuild(guild.id, `manual leave active, skip reconnect for ${guild.name}`);
            return;
        }

        if (s.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            s.lastError = 'reconnect limit reached';
            touchState(guild.id);
            logGuild(guild.id, `reconnect limit reached for ${guild.name}`);
            return;
        }

        if (reconnectLocked(guild.id)) {
            logGuild(guild.id, `reconnect already locked for ${guild.name}`);
            return;
        }

        lockReconnect(guild.id, RECONNECT_DEBOUNCE_MS + 5_000);
        s.lastReconnectAttemptAt = now();
        s.reconnectAttempts += 1;
        touchState(guild.id);

        logGuild(guild.id, `possible disconnect from ${guild.name}, rechecking...`);

        await sleep(RECONNECT_DEBOUNCE_MS);

        try {
            if (manualLeaveActive(s)) return;
            if (getVoiceConnection(guild.id)) return;

            if (!s.channelId) {
                await syncGuildStateFromLiveVoice(guild);
            }

            if (!s.channelId) return;

            const target = guild.channels.cache.get(s.channelId);
            if (!isVoiceChannel(target)) return;

            logGuild(guild.id, `rejoining ${guild.name} -> ${target.name}`);
            await joinVoice(guild, s.channelId, 'auto-reconnect');
        } catch (err) {
            s.lastError = err?.message || String(err);
            touchState(guild.id);
            console.error(err);
        } finally {
            unlockReconnect(guild.id);
        }
    });

    const ready = await waitForReady(connection);
    if (!ready) {
        state.lastError = 'voice connection not ready';
        touchState(guild.id);
        logGuild(guild.id, `voice join not ready in ${guild.name}`);
    }

    state.lastKnownVoiceState = 'joined';
    touchState(guild.id);
    logGuild(guild.id, `joined ${guild.name} -> ${channel.name}`);
    return `🎧 Joined ${channel.name}`;
}

async function leaveVoice(guild) {
    if (!guild) return '❌ Guild not found';

    const state = getState(guild.id);
    state.manualLeave = true;
    state.manualLeaveUntil = now() + MANUAL_LEAVE_COOLDOWN_MS;
    state.lastLeaveAt = now();
    state.pendingJoinReason = null;
    state.reconnectAttempts = 0;
    state.lastKnownVoiceState = 'manual-leave';
    state.channelId = null;
    touchState(guild.id);

    const left = await disconnectLiveVoice(guild);
    if (!left) {
        return '❌ Bot was not in voice';
    }

    logGuild(guild.id, `manual leave applied in ${guild.name}`);
    return '👋 Left voice (auto rejoin disabled)';
}

async function tts(guild, text) {
    if (!guild) return '❌ Guild not found';

    const state = getState(guild.id);
    const conn = getVoiceConnection(guild.id);
    if (!conn) return '❌ Not in voice';

    if (state.ttsQueue.length >= MAX_TTS_QUEUE) {
        return '🔊 Queue full';
    }

    if (state.ttsPlaying || state.ttsLock) {
        state.ttsQueue.push(String(text));
        touchState(guild.id);
        return '🔊 Queued speaking';
    }

    state.ttsLock = true;
    touchState(guild.id);

    const filePath = buildAudioPath(guild.id);

    return new Promise((resolve) => {
        try {
            const gtts = new gTTS(String(text), 'en');

            gtts.save(filePath, (err) => {
                if (err) {
                    state.ttsLock = false;
                    state.lastError = err?.message || String(err);
                    touchState(guild.id);
                    console.error(err);
                    return resolve('❌ TTS failed');
                }

                try {
                    const resource = createAudioResource(fs.createReadStream(filePath), {
                        inputType: StreamType.Arbitrary
                    });

                    state.ttsPlaying = true;
                    state.lastKnownVoiceState = 'tts-playing';
                    touchState(guild.id);

                    player.play(resource);
                    conn.subscribe(player);

                    const cleanup = () => {
                        state.ttsPlaying = false;
                        state.ttsLock = false;
                        state.lastKnownVoiceState = 'tts-idle';
                        touchState(guild.id);

                        try {
                            fs.unlinkSync(filePath);
                        } catch {}

                        const next = state.ttsQueue.shift();
                        if (next && !state.manualLeave) {
                            tts(guild, next).catch(() => {});
                        }
                    };

                    player.once(AudioPlayerStatus.Idle, cleanup);
                    player.once('error', cleanup);

                    return resolve(`🔊 Speaking: ${text}`);
                } catch (err2) {
                    state.ttsLock = false;
                    state.ttsPlaying = false;
                    state.lastError = err2?.message || String(err2);
                    touchState(guild.id);
                    console.error(err2);
                    try { fs.unlinkSync(filePath); } catch {}
                    return resolve('❌ TTS failed');
                }
            });
        } catch (err) {
            state.ttsLock = false;
            state.ttsPlaying = false;
            state.lastError = err?.message || String(err);
            touchState(guild.id);
            console.error(err);
            return resolve('❌ TTS failed');
        }
    });
}

async function safeReplyInteraction(interaction, content) {
    try {
        if (interaction.deferred || interaction.replied) {
            return interaction.editReply(content);
        }
        return interaction.reply({ content });
    } catch (err) {
        console.error(err);
        try {
            if (interaction.deferred || interaction.replied) {
                return interaction.editReply('❌ Error');
            }
        } catch {}
    }
}

async function getMemberVoiceChannel(guild, userId) {
    if (!guild || !userId) return null;
    const member = await guild.members.fetch(userId).catch(() => null);
    return voiceChannelFromMember(member);
}

function buildCommandData() {
    return [
        new SlashCommandBuilder().setName('join').setDescription('Join your voice channel'),
        new SlashCommandBuilder().setName('leave').setDescription('Leave voice and disable rejoin'),
        new SlashCommandBuilder().setName('tts').setDescription('Speak text').addStringOption(opt =>
            opt.setName('text').setDescription('Text to speak').setRequired(true)
        ),
        new SlashCommandBuilder().setName('status').setDescription('Show voice status'),
        new SlashCommandBuilder().setName('help').setDescription('Show commands'),
        new SlashCommandBuilder().setName('ping').setDescription('Ping the bot')
    ].map(c => c.toJSON());
}

async function clearGlobalCommands() {
    if (!CLEAR_GLOBAL_COMMANDS) return;
    try {
        await commandREST.put(Routes.applicationCommands(CLIENT_ID), { body: [] });
        console.log('🧹 Cleared global slash commands');
    } catch (err) {
        console.error('Failed to clear global slash commands:', err?.message || err);
    }
}

async function registerGuildCommands(guild) {
    if (!guild) return;
    try {
        await commandREST.put(Routes.applicationGuildCommands(CLIENT_ID, guild.id), {
            body: buildCommandData()
        });
        console.log(`⚡ Slash commands registered for ${guild.name}`);
    } catch (err) {
        console.error(`Failed to register commands for ${guild.name}:`, err?.message || err);
    }
}

async function registerCommandsEverywhere() {
    await clearGlobalCommands();
    for (const [, guild] of client.guilds.cache) {
        await registerGuildCommands(guild);
    }
}

async function syncAllGuildStatesFromLiveVoice() {
    for (const [, guild] of client.guilds.cache) {
        await syncGuildStateFromLiveVoice(guild).catch(() => {});
    }
}

function cleanupGuildState(guildId) {
    guildState.delete(safeId(guildId));
    reconnectLocks.delete(safeId(guildId));
}

function getStatusLines(guild) {
    const state = getState(guild.id);
    return [
        `Guild: ${guild.name}`,
        `Voice target: ${state.channelId || 'none'}`,
        `Manual leave: ${state.manualLeave ? 'yes' : 'no'}`,
        `Reconnect attempts: ${state.reconnectAttempts}`,
        `TTS queue: ${state.ttsQueue.length}`,
        `TTS playing: ${state.ttsPlaying ? 'yes' : 'no'}`,
        `Last error: ${state.lastError || 'none'}`
    ].join('\n');
}

client.on('messageCreate', async (message) => {
    if (!message.guild || message.author.bot) return;
    if (!String(message.content || '').startsWith(PREFIX)) return;

    const args = String(message.content).slice(PREFIX.length).trim().split(/\s+/);
    const cmd = String(args.shift() || '').toLowerCase();
    const state = getState(message.guild.id);

    if (cmd === 'join') {
        const vc = message.member?.voice?.channel || null;
        if (!vc) return message.reply('❌ You are not in a voice channel');
        state.manualLeave = false;
        state.manualLeaveUntil = 0;
        return message.reply(await joinVoice(message.guild, vc.id, 'prefix'));
    }

    if (cmd === 'leave') {
        return message.reply(await leaveVoice(message.guild));
    }

    if (cmd === 'tts') {
        const text = args.join(' ');
        if (!text) return message.reply('Usage: !tts hello');
        return message.reply(await tts(message.guild, text));
    }

    if (cmd === 'status') {
        return message.reply('```\n' + getStatusLines(message.guild) + '\n```');
    }

    if (cmd === 'help') {
        return message.reply([
            'Commands:',
            '!join',
            '!leave',
            '!tts <text>',
            '!status',
            '/join',
            '/leave',
            '/tts',
            '/status'
        ].join('\n'));
    }

    if (cmd === 'ping') {
        return message.reply('pong');
    }

    state.lastKnownVoiceState = `message:${cmd}`;
    touchState(message.guild.id);
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (!interaction.inGuild() || !interaction.guild) {
        return safeReplyInteraction(interaction, '❌ This command only works in a server');
    }

    const state = getState(interaction.guild.id);

    try {
        if (interaction.commandName === 'join') {
            await interaction.deferReply();
            const vc = await getMemberVoiceChannel(interaction.guild, interaction.user.id);
            if (!vc) return interaction.editReply('❌ You are not in a voice channel');
            state.manualLeave = false;
            state.manualLeaveUntil = 0;
            return interaction.editReply(await joinVoice(interaction.guild, vc.id, 'slash'));
        }

        if (interaction.commandName === 'leave') {
            await interaction.deferReply();
            return interaction.editReply(await leaveVoice(interaction.guild));
        }

        if (interaction.commandName === 'tts') {
            await interaction.deferReply();
            const text = interaction.options.getString('text');
            return interaction.editReply(await tts(interaction.guild, text));
        }

        if (interaction.commandName === 'status') {
            await interaction.deferReply();
            return interaction.editReply('```\n' + getStatusLines(interaction.guild) + '\n```');
        }

        if (interaction.commandName === 'help') {
            await interaction.deferReply();
            return interaction.editReply([
                'Commands:',
                '/join',
                '/leave',
                '/tts <text>',
                '/status',
                'Prefix commands also work: !join !leave !tts !status'
            ].join('\n'));
        }

        if (interaction.commandName === 'ping') {
            await interaction.deferReply();
            return interaction.editReply('pong');
        }
    } catch (err) {
        console.error(err);
        try {
            if (interaction.deferred || interaction.replied) {
                return interaction.editReply('❌ Error');
            }
        } catch {}
    }
});

client.on('voiceStateUpdate', async (oldState, newState) => {
    if (!client.user) return;
    if (oldState.id !== client.user.id) return;

    const guild = oldState.guild;
    const state = getState(guild.id);

    if (manualLeaveActive(state)) {
        state.lastKnownVoiceState = 'manual-leave-ignored';
        touchState(guild.id);
        return;
    }

    if (newState.channelId) {
        if (state.channelId !== newState.channelId) {
            state.channelId = newState.channelId;
            state.lastKnownVoiceState = 'moved';
            touchState(guild.id);
        }
        return;
    }

    state.lastDisconnectAt = now();
    state.lastKnownVoiceState = 'disconnected';
    touchState(guild.id);

    if (reconnectLocked(guild.id)) return;
    if (state.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) return;

    lockReconnect(guild.id, RECONNECT_DEBOUNCE_MS + 5_000);
    state.lastReconnectAttemptAt = now();
    state.reconnectAttempts += 1;
    touchState(guild.id);

    setTimeout(async () => {
        try {
            if (manualLeaveActive(state)) return;
            if (getVoiceConnection(guild.id)) return;
            await syncGuildStateFromLiveVoice(guild);
            if (!state.channelId) return;
            await joinVoice(guild, state.channelId, 'voice-disconnect');
        } catch (err) {
            state.lastError = err?.message || String(err);
            console.error(err);
        } finally {
            unlockReconnect(guild.id);
        }
    }, RECONNECT_DEBOUNCE_MS);
});

client.on('guildCreate', async (guild) => {
    getState(guild.id);
    await registerGuildCommands(guild);
    await syncGuildStateFromLiveVoice(guild).catch(() => {});
});

client.on('guildDelete', (guild) => {
    cleanupGuildState(guild.id);
});

client.on('error', (err) => {
    console.error('Client error:', err);
});

process.on('unhandledRejection', (err) => {
    console.error('Unhandled rejection:', err);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
});

client.once('ready', async () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    await registerCommandsEverywhere();
    await syncAllGuildStatesFromLiveVoice();
});

setInterval(() => {
    for (const [guildId, state] of guildState.entries()) {
        if (manualLeaveActive(state)) continue;
        if (!state.channelId) continue;
        if (reconnectLocked(guildId)) continue;
        const guild = getGuildById(guildId);
        if (!guild) continue;
        const conn = getVoiceConnection(guild.id);
        if (!conn) {
            joinVoice(guild, state.channelId, 'watchdog').catch(err => {
                state.lastError = err?.message || String(err);
                touchState(guildId);
            });
        }
    }
}, WATCHDOG_INTERVAL_MS);

setInterval(() => {
    for (const [guildId, state] of guildState.entries()) {
        if (state.manualLeave && state.manualLeaveUntil && now() > state.manualLeaveUntil) {
            state.manualLeave = false;
            state.manualLeaveUntil = 0;
            touchState(guildId);
        }

        if (state.ttsQueue.length > MAX_TTS_QUEUE) {
            state.ttsQueue = state.ttsQueue.slice(0, MAX_TTS_QUEUE);
        }

        if (state.reconnectLockedUntil && now() > state.reconnectLockedUntil) {
            unlockReconnect(guildId);
        }
    }
}, 30_000);

client.login(TOKEN);

const app = express();
app.get('/', (_, res) => res.send('Bot alive'));
app.get('/health', (_, res) => res.send('ok'));
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Web server running on port ${PORT}`);
});

function getGuildSummary(guildId) {
    const s = getState(guildId);
    return {
        guildId: s.guildId,
        channelId: s.channelId,
        manualLeave: s.manualLeave,
        manualLeaveUntil: s.manualLeaveUntil,
        lastJoinAt: s.lastJoinAt,
        lastLeaveAt: s.lastLeaveAt,
        lastDisconnectAt: s.lastDisconnectAt,
        lastReconnectAttemptAt: s.lastReconnectAttemptAt,
        reconnectAttempts: s.reconnectAttempts,
        reconnectLockedUntil: s.reconnectLockedUntil,
        ttsQueueLength: s.ttsQueue.length,
        ttsPlaying: s.ttsPlaying,
        ttsLock: s.ttsLock,
        pendingJoinReason: s.pendingJoinReason,
        lastKnownVoiceState: s.lastKnownVoiceState,
        lastError: s.lastError,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt
    };
}

function dumpStateToConsole() {
    const out = {};
    for (const [guildId] of guildState.entries()) {
        out[guildId] = getGuildSummary(guildId);
    }
    console.log(JSON.stringify(out, null, 2));
}

function resetGuildState(guildId) {
    guildState.set(safeId(guildId), {
        guildId: safeId(guildId),
        channelId: null,
        manualLeave: false,
        manualLeaveUntil: 0,
        lastJoinAt: 0,
        lastLeaveAt: 0,
        lastDisconnectAt: 0,
        lastReconnectAttemptAt: 0,
        reconnectAttempts: 0,
        lastKnownVoiceState: null,
        reconnectLockedUntil: 0,
        pendingJoinReason: null,
        lastError: null,
        ttsQueue: [],
        ttsPlaying: false,
        ttsLock: false,
        createdAt: now(),
        updatedAt: now()
    });
}

function forceStopAllAudio() {
    try {
        player.stop(true);
    } catch {}
    for (const [, s] of guildState.entries()) {
        s.ttsPlaying = false;
        s.ttsLock = false;
        s.ttsQueue = [];
        s.updatedAt = now();
    }
}

async function forceReconnectGuild(guildId) {
    const guild = getGuildById(guildId);
    const s = getState(guildId);
    if (!guild) return false;
    if (manualLeaveActive(s)) return false;
    if (!s.channelId) return false;
    if (reconnectLocked(guildId)) return false;
    await joinVoice(guild, s.channelId, 'forced');
    return true;
}

async function forceReconnectAllGuilds() {
    const results = [];
    for (const guildId of guildState.keys()) {
        try {
            results.push({ guildId, ok: await forceReconnectGuild(guildId) });
        } catch (err) {
            results.push({ guildId, ok: false, error: err?.message || String(err) });
        }
    }
    return results;
}

function canAutoRejoin(guildId) {
    const s = getState(guildId);
    return !manualLeaveActive(s) && !!s.channelId;
}

function getGuildVoiceStatus(guildId) {
    const s = getState(guildId);
    return {
        liveConnection: !!getVoiceConnection(safeId(guildId)),
        targetChannelId: s.channelId,
        manualLeave: s.manualLeave,
        manualLeaveUntil: s.manualLeaveUntil,
        reconnectAttempts: s.reconnectAttempts,
        ttsPlaying: s.ttsPlaying,
        queue: s.ttsQueue.length,
        lastError: s.lastError,
        lastKnownVoiceState: s.lastKnownVoiceState
    };
}

// End of file.
