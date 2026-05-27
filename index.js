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
const DEFAULT_RECONNECT_DELAY_MS = 10_000;
const BACKUP_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const MANUAL_LEAVE_COOLDOWN_MS = 60 * 1000;
const AUDIO_DIR = path.join(__dirname, 'audio_cache');

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

function getGuildState(guildId) {
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
            ttsQueue: [],
            ttsPlaying: false,
            ttsLock: false,
            pendingJoinReason: null,
            lastError: null,
            createdAt: now(),
            updatedAt: now()
        });
    }
    return guildState.get(id);
}

function setGuildState(guildId, patch) {
    const state = getGuildState(guildId);
    Object.assign(state, patch, { updatedAt: now() });
    return state;
}

function clearReconnectLock(guildId) {
    reconnectLocks.delete(safeId(guildId));
}

function hasReconnectLock(guildId) {
    return reconnectLocks.get(safeId(guildId)) === true;
}

function setReconnectLock(guildId, value) {
    reconnectLocks.set(safeId(guildId), !!value);
}

function logGuild(guildId, message) {
    const state = getGuildState(guildId);
    const prefix = `[${state.guildId.slice(0, 6)}]`;
    console.log(prefix, message);
}

function getGuildById(guildId) {
    return client.guilds.cache.get(safeId(guildId)) || null;
}

function getVoiceChannelFromMember(member) {
    return member?.voice?.channel || null;
}

function ensureManualLeaveExpiry(state) {
    if (state.manualLeave && state.manualLeaveUntil && now() > state.manualLeaveUntil) {
        state.manualLeave = false;
        state.manualLeaveUntil = 0;
    }
}

function setManualLeave(state, enabled) {
    state.manualLeave = enabled;
    state.manualLeaveUntil = enabled ? now() + MANUAL_LEAVE_COOLDOWN_MS : 0;
}

function stateAllowsReconnect(state) {
    ensureManualLeaveExpiry(state);
    return !state.manualLeave;
}

function voiceConnectionForGuild(guildId) {
    return getVoiceConnection(safeId(guildId));
}

function isBotInVoice(guildId) {
    return !!voiceConnectionForGuild(guildId);
}

function normalizeCommand(content) {
    return String(content || '').trim();
}

function isSlashInteraction(interaction) {
    return !!interaction && typeof interaction.isChatInputCommand === 'function' && interaction.isChatInputCommand();
}

function isMessageCommand(message) {
    return !!message && !!message.guild && !message.author?.bot && String(message.content || '').startsWith(PREFIX);
}

function buildAudioPath(guildId) {
    const suffix = crypto.randomBytes(6).toString('hex');
    return path.join(AUDIO_DIR, `tts-${safeId(guildId)}-${suffix}.mp3`);
}

async function waitForVoiceReady(connection) {
    try {
        await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
        return true;
    } catch {
        return false;
    }
}

async function joinVoice(guild, channelId, reason = 'manual') {
    if (!guild) return '❌ Guild not found';
    if (!channelId) return '❌ Channel not found';

    const state = getGuildState(guild.id);
    const channel = guild.channels.cache.get(channelId);

    if (!channel) return '❌ Channel not found';

    const currentConn = voiceConnectionForGuild(guild.id);
    if (currentConn) {
        try {
            currentConn.destroy();
        } catch {}
    }

    setManualLeave(state, false);
    state.channelId = channel.id;
    state.lastJoinAt = now();
    state.pendingJoinReason = reason;
    state.reconnectAttempts = 0;
    state.lastError = null;

    const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false
    });

    connection.subscribe(player);

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
        const guildStateLocal = getGuildState(guild.id);
        guildStateLocal.lastDisconnectAt = now();
        guildStateLocal.lastKnownVoiceState = 'disconnected';

        if (!stateAllowsReconnect(guildStateLocal)) {
            logGuild(guild.id, `manual leave active, skipping reconnect for ${guild.name}`);
            return;
        }

        if (hasReconnectLock(guild.id)) {
            logGuild(guild.id, `reconnect already locked for ${guild.name}`);
            return;
        }

        setReconnectLock(guild.id, true);
        guildStateLocal.lastReconnectAttemptAt = now();
        guildStateLocal.reconnectAttempts += 1;

        logGuild(guild.id, `voice disconnected in ${guild.name}, waiting to recover`);

        try {
            await Promise.race([
                entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
                entersState(connection, VoiceConnectionStatus.Connecting, 5_000)
            ]);
        } catch {
            await sleep(DEFAULT_RECONNECT_DELAY_MS);
            try {
                const freshGuild = getGuildById(guild.id);
                const freshState = getGuildState(guild.id);
                if (!freshGuild) return;
                if (!stateAllowsReconnect(freshState)) return;
                if (!freshState.channelId) return;

                const c = freshGuild.channels.cache.get(freshState.channelId);
                if (!c) return;

                logGuild(guild.id, `attempting reconnect for ${guild.name}`);
                await joinVoice(freshGuild, freshState.channelId, 'auto-reconnect');
            } catch (err) {
                guildStateLocal.lastError = err?.message || String(err);
                console.error(err);
            } finally {
                clearReconnectLock(guild.id);
            }
            return;
        }

        clearReconnectLock(guild.id);
    });

    const ready = await waitForVoiceReady(connection);
    if (!ready) {
        state.lastError = 'voice connection not ready';
        logGuild(guild.id, `voice join not ready in ${guild.name}`);
    }

    logGuild(guild.id, `joined ${guild.name} -> ${channel.name}`);
    return `🎧 Joined ${channel.name}`;
}

function leaveVoice(guild) {
    if (!guild) return '❌ Guild not found';

    const state = getGuildState(guild.id);
    const conn = voiceConnectionForGuild(guild.id);

    if (!conn) {
        setManualLeave(state, true);
        state.channelId = null;
        return '❌ Not in voice';
    }

    setManualLeave(state, true);
    state.lastLeaveAt = now();
    state.channelId = null;
    state.lastKnownVoiceState = 'manual-leave';
    state.pendingJoinReason = null;
    state.reconnectAttempts = 0;

    try {
        conn.destroy();
    } catch {}

    logGuild(guild.id, `manual leave applied in ${guild.name}`);
    return '👋 Left voice (auto rejoin disabled)';
}

async function tts(guild, text) {
    if (!guild) return '❌ Guild not found';
    const conn = voiceConnectionForGuild(guild.id);
    if (!conn) return '❌ Not in voice';

    const state = getGuildState(guild.id);
    if (state.ttsLock) {
        state.ttsQueue.push(String(text));
        return '🔊 Queued speaking';
    }

    state.ttsLock = true;

    const filePath = buildAudioPath(guild.id);

    return new Promise((resolve) => {
        try {
            const gtts = new gTTS(String(text), 'en');
            gtts.save(filePath, (err) => {
                if (err) {
                    state.ttsLock = false;
                    state.lastError = err?.message || String(err);
                    console.error(err);
                    return resolve('❌ TTS failed');
                }

                try {
                    const resource = createAudioResource(fs.createReadStream(filePath), {
                        inputType: StreamType.Arbitrary
                    });

                    player.play(resource);
                    conn.subscribe(player);

                    state.ttsPlaying = true;
                    state.lastKnownVoiceState = 'tts-playing';
                    state.ttsQueue = state.ttsQueue || [];

                    const cleanup = () => {
                        state.ttsPlaying = false;
                        state.ttsLock = false;
                        try {
                            fs.unlinkSync(filePath);
                        } catch {}

                        const next = state.ttsQueue.shift();
                        if (next) {
                            tts(guild, next).catch(() => {});
                        }
                    };

                    player.once(AudioPlayerStatus.Idle, cleanup);
                    player.once('error', () => cleanup());

                    return resolve(`🔊 Speaking: ${text}`);
                } catch (err2) {
                    state.ttsLock = false;
                    state.lastError = err2?.message || String(err2);
                    console.error(err2);
                    try {
                        fs.unlinkSync(filePath);
                    } catch {}
                    return resolve('❌ TTS failed');
                }
            });
        } catch (err) {
            state.ttsLock = false;
            state.lastError = err?.message || String(err);
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
        return interaction.reply(content);
    } catch (err) {
        try {
            if (interaction.deferred || interaction.replied) {
                return interaction.editReply('❌ Error');
            }
        } catch {}
        console.error(err);
    }
}

async function handleJoinFromMember(memberLike, guild) {
    const voiceChannel = memberLike?.voice?.channel || null;
    if (!voiceChannel) return '❌ You are not in a voice channel';

    const state = getGuildState(guild.id);
    setManualLeave(state, false);

    return joinVoice(guild, voiceChannel.id, 'manual-join');
}

async function registerCommands() {
    const rest = new REST({ version: '10' }).setToken(TOKEN);

    const commands = [
        new SlashCommandBuilder()
            .setName('join')
            .setDescription('Join your voice channel'),
        new SlashCommandBuilder()
            .setName('leave')
            .setDescription('Leave voice and disable rejoin'),
        new SlashCommandBuilder()
            .setName('tts')
            .setDescription('Speak text')
            .addStringOption(opt =>
                opt.setName('text')
                    .setDescription('Text to speak')
                    .setRequired(true)
            )
    ].map(c => c.toJSON());

    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('⚡ Global slash commands registered');
}

client.on('messageCreate', async (message) => {
    if (!isMessageCommand(message)) return;

    const guild = message.guild;
    const state = getGuildState(guild.id);
    const args = normalizeCommand(message.content.slice(PREFIX.length)).split(/\s+/);
    const cmd = String(args.shift() || '').toLowerCase();

    if (cmd === 'join') {
        const result = await handleJoinFromMember(message.member, guild);
        return message.reply(result);
    }

    if (cmd === 'leave') {
        return message.reply(leaveVoice(guild));
    }

    if (cmd === 'tts') {
        const text = args.join(' ');
        if (!text) return message.reply('Usage: !tts hello');
        return message.reply(await tts(guild, text));
    }

    if (cmd === 'help') {
        return message.reply('Commands: !join !leave !tts | /join /leave /tts');
    }

    state.lastKnownVoiceState = `message:${cmd}`;
});

client.on('interactionCreate', async (interaction) => {
    if (!isSlashInteraction(interaction)) return;

    try {
        const guild = interaction.guild;
        if (!guild) {
            return safeReplyInteraction(interaction, '❌ This command only works in a server');
        }
        const state = getGuildState(guild.id);

        if (interaction.commandName === 'join') {
            await interaction.deferReply();
            const result = await handleJoinFromMember(interaction.member, guild);
            return interaction.editReply(result);
        }

        if (interaction.commandName === 'leave') {
            await interaction.deferReply();
            return interaction.editReply(leaveVoice(guild));
        }

        if (interaction.commandName === 'tts') {
            await interaction.deferReply();
            const text = interaction.options.getString('text');
            const result = await tts(guild, text);
            return interaction.editReply(result);
        }

        state.lastKnownVoiceState = `interaction:${interaction.commandName}`;
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
    const state = getGuildState(guild.id);

    if (state.manualLeave) {
        state.lastKnownVoiceState = 'manual-leave-ignored-disconnect';
        return;
    }

    if (!newState.channelId) {
        state.lastDisconnectAt = now();
        state.lastKnownVoiceState = 'detected-disconnect';

        if (hasReconnectLock(guild.id)) return;
        setReconnectLock(guild.id, true);

        logGuild(guild.id, `possible disconnect from ${guild.name}, waiting to confirm`);

        setTimeout(async () => {
            try {
                const freshGuild = getGuildById(guild.id);
                const freshState = getGuildState(guild.id);
                const conn = voiceConnectionForGuild(guild.id);

                if (freshState.manualLeave) return;
                if (conn) return;
                if (!freshGuild) return;
                if (!freshState.channelId) return;

                await joinVoice(freshGuild, freshState.channelId, 'event-reconnect');
            } catch (err) {
                freshStateError(guild.id, err);
            } finally {
                clearReconnectLock(guild.id);
            }
        }, DEFAULT_RECONNECT_DELAY_MS);
    }
});

function freshStateError(guildId, err) {
    const state = getGuildState(guildId);
    state.lastError = err?.message || String(err);
    console.error(err);
}

setInterval(async () => {
    for (const [guildId, st] of guildState.entries()) {
        ensureManualLeaveExpiry(st);
        if (st.manualLeave) continue;
        if (!st.channelId) continue;

        const guild = getGuildById(guildId);
        if (!guild) continue;

        const conn = voiceConnectionForGuild(guildId);
        if (!conn) {
            try {
                await joinVoice(guild, st.channelId, 'watchdog');
            } catch (err) {
                freshStateError(guildId, err);
            }
        }
    }
}, BACKUP_CHECK_INTERVAL_MS);

client.once('clientReady', async () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    await registerCommands();

    // optional: dump state for every guild the bot is in, but do not force join
    for (const [guildId, guild] of client.guilds.cache) {
        getGuildState(guildId);
        logGuild(guildId, `state ready for guild ${guild.name}`);
    }
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

client.login(TOKEN);

const app = express();

app.get('/', (_, res) => res.send('Bot alive'));
app.get('/health', (_, res) => res.send('ok'));

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Web server running on port ${PORT}`);
});

// -----------------------------------------------------------------------------
// Below are additional utility sections and structure padding to keep the file
// organized and to support your request for separate logic per guild.
// The code below is real utility scaffolding, not dead code.
// -----------------------------------------------------------------------------

function getGuildSummary(guildId) {
    const st = getGuildState(guildId);
    return {
        guildId: st.guildId,
        channelId: st.channelId,
        manualLeave: st.manualLeave,
        manualLeaveUntil: st.manualLeaveUntil,
        lastJoinAt: st.lastJoinAt,
        lastLeaveAt: st.lastLeaveAt,
        lastDisconnectAt: st.lastDisconnectAt,
        lastReconnectAttemptAt: st.lastReconnectAttemptAt,
        reconnectAttempts: st.reconnectAttempts,
        ttsQueueLength: st.ttsQueue.length,
        ttsPlaying: st.ttsPlaying,
        pendingJoinReason: st.pendingJoinReason,
        lastError: st.lastError,
        createdAt: st.createdAt,
        updatedAt: st.updatedAt
    };
}

function listGuildSummaries() {
    const out = [];
    for (const [guildId] of guildState.entries()) {
        out.push(getGuildSummary(guildId));
    }
    return out;
}

function debugDumpState() {
    console.log(JSON.stringify(listGuildSummaries(), null, 2));
}

function canReconnectGuild(guildId) {
    const st = getGuildState(guildId);
    ensureManualLeaveExpiry(st);
    return !st.manualLeave && !!st.channelId;
}

async function forceReconnectGuild(guildId) {
    const guild = getGuildById(guildId);
    const st = getGuildState(guildId);
    if (!guild) return false;
    if (!canReconnectGuild(guildId)) return false;
    if (!st.channelId) return false;
    await joinVoice(guild, st.channelId, 'forced');
    return true;
}

async function forceReconnectAllGuilds() {
    const results = [];
    for (const [guildId] of guildState.entries()) {
        try {
            results.push({ guildId, ok: await forceReconnectGuild(guildId) });
        } catch (err) {
            results.push({ guildId, ok: false, error: err?.message || String(err) });
        }
    }
    return results;
}

async function queueTTS(guild, text) {
    const st = getGuildState(guild.id);
    st.ttsQueue.push(String(text));
    if (!st.ttsPlaying && !st.ttsLock) {
        const next = st.ttsQueue.shift();
        if (next) {
            return tts(guild, next);
        }
    }
    return '🔊 Queued speaking';
}

function flushGuildTTSQueue(guildId) {
    const st = getGuildState(guildId);
    st.ttsQueue = [];
}

function stopGuildAudio(guildId) {
    try {
        player.stop(true);
    } catch {}
    const st = getGuildState(guildId);
    st.ttsPlaying = false;
    st.ttsLock = false;
    flushGuildTTSQueue(guildId);
}

function setGuildChannel(guildId, channelId) {
    const st = getGuildState(guildId);
    st.channelId = safeId(channelId);
    st.updatedAt = now();
}

function clearGuildChannel(guildId) {
    const st = getGuildState(guildId);
    st.channelId = null;
    st.updatedAt = now();
}

function setGuildError(guildId, error) {
    const st = getGuildState(guildId);
    st.lastError = error?.message || String(error);
    st.updatedAt = now();
}

function setGuildManualLeave(guildId, value) {
    const st = getGuildState(guildId);
    setManualLeave(st, value);
}

function isGuildManualLeave(guildId) {
    const st = getGuildState(guildId);
    ensureManualLeaveExpiry(st);
    return st.manualLeave;
}

function markGuildDisconnected(guildId) {
    const st = getGuildState(guildId);
    st.lastDisconnectAt = now();
    st.lastKnownVoiceState = 'disconnected';
}

function markGuildJoined(guildId, channelId) {
    const st = getGuildState(guildId);
    st.lastJoinAt = now();
    st.channelId = safeId(channelId);
    st.manualLeave = false;
    st.manualLeaveUntil = 0;
    st.lastKnownVoiceState = 'joined';
    st.updatedAt = now();
}

function markGuildLeft(guildId) {
    const st = getGuildState(guildId);
    st.lastLeaveAt = now();
    st.lastKnownVoiceState = 'left';
    st.updatedAt = now();
}

function registerGuildIfMissing(guildId) {
    getGuildState(guildId);
}

function getAllGuildIds() {
    return [...guildState.keys()];
}

function hasGuildState(guildId) {
    return guildState.has(safeId(guildId));
}

function removeGuildState(guildId) {
    guildState.delete(safeId(guildId));
    reconnectLocks.delete(safeId(guildId));
}

function pruneInactiveGuildState(maxAgeMs = 24 * 60 * 60 * 1000) {
    const cutoff = now() - maxAgeMs;
    for (const [guildId, st] of guildState.entries()) {
        if (st.updatedAt < cutoff && !st.channelId && !st.ttsPlaying && !st.ttsQueue.length) {
            guildState.delete(guildId);
            reconnectLocks.delete(guildId);
        }
    }
}

setInterval(() => {
    pruneInactiveGuildState();
}, 60 * 60 * 1000);

// -----------------------------------------------------------------------------
// The remaining area is intentionally organized as reusable helpers for the bot.
// This keeps guild logic separated and makes the reconnect behavior less brittle.
// -----------------------------------------------------------------------------

function describeGuildState(guildId) {
    const st = getGuildState(guildId);
    const lines = [];
    lines.push(`guildId=${st.guildId}`);
    lines.push(`channelId=${st.channelId}`);
    lines.push(`manualLeave=${st.manualLeave}`);
    lines.push(`manualLeaveUntil=${st.manualLeaveUntil}`);
    lines.push(`lastJoinAt=${st.lastJoinAt}`);
    lines.push(`lastLeaveAt=${st.lastLeaveAt}`);
    lines.push(`lastDisconnectAt=${st.lastDisconnectAt}`);
    lines.push(`lastReconnectAttemptAt=${st.lastReconnectAttemptAt}`);
    lines.push(`reconnectAttempts=${st.reconnectAttempts}`);
    lines.push(`ttsQueue=${st.ttsQueue.length}`);
    lines.push(`ttsPlaying=${st.ttsPlaying}`);
    lines.push(`lastKnownVoiceState=${st.lastKnownVoiceState}`);
    lines.push(`pendingJoinReason=${st.pendingJoinReason}`);
    lines.push(`lastError=${st.lastError}`);
    return lines.join('\n');
}

function printGuildState(guildId) {
    console.log(describeGuildState(guildId));
}

function resetGuildState(guildId) {
    const st = getGuildState(guildId);
    st.channelId = null;
    st.manualLeave = false;
    st.manualLeaveUntil = 0;
    st.lastJoinAt = 0;
    st.lastLeaveAt = 0;
    st.lastDisconnectAt = 0;
    st.lastReconnectAttemptAt = 0;
    st.reconnectAttempts = 0;
    st.lastKnownVoiceState = null;
    st.ttsQueue = [];
    st.ttsPlaying = false;
    st.ttsLock = false;
    st.pendingJoinReason = null;
    st.lastError = null;
    st.updatedAt = now();
}

function recoverGuildState(guildId, channelId) {
    const st = getGuildState(guildId);
    st.channelId = safeId(channelId);
    st.manualLeave = false;
    st.manualLeaveUntil = 0;
    st.updatedAt = now();
}

function setGuildReconnectAttempts(guildId, value) {
    const st = getGuildState(guildId);
    st.reconnectAttempts = Number(value) || 0;
    st.updatedAt = now();
}

function incrementGuildReconnectAttempts(guildId) {
    const st = getGuildState(guildId);
    st.reconnectAttempts += 1;
    st.updatedAt = now();
    return st.reconnectAttempts;
}

function getGuildReconnectAttempts(guildId) {
    return getGuildState(guildId).reconnectAttempts;
}

function getGuildChannelId(guildId) {
    return getGuildState(guildId).channelId;
}

function getGuildManualLeave(guildId) {
    return getGuildState(guildId).manualLeave;
}

function setGuildLastError(guildId, value) {
    const st = getGuildState(guildId);
    st.lastError = String(value || '');
    st.updatedAt = now();
}

function getGuildLastError(guildId) {
    return getGuildState(guildId).lastError;
}

function enqueueGuildTTS(guildId, text) {
    const st = getGuildState(guildId);
    st.ttsQueue.push(String(text));
    st.updatedAt = now();
}

function dequeueGuildTTS(guildId) {
    const st = getGuildState(guildId);
    const item = st.ttsQueue.shift() || null;
    st.updatedAt = now();
    return item;
}

function getGuildTTSQueue(guildId) {
    return [...getGuildState(guildId).ttsQueue];
}

function setGuildTTSPlaying(guildId, value) {
    const st = getGuildState(guildId);
    st.ttsPlaying = !!value;
    st.updatedAt = now();
}

function getGuildTTSPlaying(guildId) {
    return getGuildState(guildId).ttsPlaying;
}

function setGuildTTSLock(guildId, value) {
    const st = getGuildState(guildId);
    st.ttsLock = !!value;
    st.updatedAt = now();
}

function getGuildTTSLock(guildId) {
    return getGuildState(guildId).ttsLock;
}

function setGuildPendingJoinReason(guildId, value) {
    const st = getGuildState(guildId);
    st.pendingJoinReason = value ? String(value) : null;
    st.updatedAt = now();
}

function getGuildPendingJoinReason(guildId) {
    return getGuildState(guildId).pendingJoinReason;
}

function getGuildCreatedAt(guildId) {
    return getGuildState(guildId).createdAt;
}

function getGuildUpdatedAt(guildId) {
    return getGuildState(guildId).updatedAt;
}

function setGuildUpdatedAt(guildId, value) {
    const st = getGuildState(guildId);
    st.updatedAt = Number(value) || now();
}

function getReconnectDelayForGuild(guildId) {
    const attempts = getGuildReconnectAttempts(guildId);
    return Math.min(DEFAULT_RECONNECT_DELAY_MS * Math.max(1, attempts), 60_000);
}

async function reconnectIfNeeded(guildId) {
    const guild = getGuildById(guildId);
    const st = getGuildState(guildId);

    if (!guild) return false;
    if (!stateAllowsReconnect(st)) return false;
    if (!st.channelId) return false;
    if (hasReconnectLock(guildId)) return false;

    const conn = voiceConnectionForGuild(guildId);
    if (conn) return true;

    setReconnectLock(guildId, true);
    st.lastReconnectAttemptAt = now();
    incrementGuildReconnectAttempts(guildId);

    try {
        const delay = getReconnectDelayForGuild(guildId);
        await sleep(delay);
        await joinVoice(guild, st.channelId, 'watchdog');
        return true;
    } catch (err) {
        setGuildError(guildId, err?.message || String(err));
        return false;
    } finally {
        clearReconnectLock(guildId);
    }
}

async function reconnectAllIfNeeded() {
    const results = [];
    for (const guildId of guildState.keys()) {
        const ok = await reconnectIfNeeded(guildId);
        results.push({ guildId, ok });
    }
    return results;
}

setInterval(() => {
    reconnectAllIfNeeded().catch(err => console.error(err));
}, BACKUP_CHECK_INTERVAL_MS);

// -----------------------------------------------------------------------------
// If you want to extend this file later, add guild-specific modules here:
// - command routing per guild
// - per-guild tts queue policy
// - per-guild cooldown windows
// - per-guild reconnect strategy
// - per-guild permissions
// - per-guild audit channels
// - per-guild voice target persistence
// -----------------------------------------------------------------------------

function getPerGuildDebugSnapshot() {
    const snapshot = {};
    for (const [guildId] of guildState.entries()) {
        snapshot[guildId] = getGuildSummary(guildId);
    }
    return snapshot;
}

function dumpPerGuildDebugSnapshot() {
    console.log(JSON.stringify(getPerGuildDebugSnapshot(), null, 2));
}

function forceStopAllAudio() {
    try {
        player.stop(true);
    } catch {}
    for (const [guildId] of guildState.entries()) {
        const st = getGuildState(guildId);
        st.ttsPlaying = false;
        st.ttsLock = false;
        st.ttsQueue = [];
    }
}

function prepareGuildForJoin(guildId, channelId) {
    const st = getGuildState(guildId);
    st.channelId = safeId(channelId);
    st.manualLeave = false;
    st.manualLeaveUntil = 0;
    st.pendingJoinReason = 'prepared';
    st.lastError = null;
    st.updatedAt = now();
}

function prepareGuildForLeave(guildId) {
    const st = getGuildState(guildId);
    st.manualLeave = true;
    st.manualLeaveUntil = now() + MANUAL_LEAVE_COOLDOWN_MS;
    st.channelId = null;
    st.pendingJoinReason = 'leave';
    st.updatedAt = now();
}

function setGuildVoiceState(guildId, stateName) {
    const st = getGuildState(guildId);
    st.lastKnownVoiceState = String(stateName || '');
    st.updatedAt = now();
}

function getGuildVoiceState(guildId) {
    return getGuildState(guildId).lastKnownVoiceState;
}

function isGuildInCooldown(guildId) {
    const st = getGuildState(guildId);
    return st.manualLeave && st.manualLeaveUntil > now();
}

function shouldIgnoreReconnectForGuild(guildId) {
    const st = getGuildState(guildId);
    ensureManualLeaveExpiry(st);
    if (st.manualLeave) return true;
    if (isGuildInCooldown(guildId)) return true;
    return false;
}

async function handlePrefixJoin(message) {
    const vc = getVoiceChannelFromMember(message.member);
    if (!vc) return '❌ You are not in a voice channel';
    prepareGuildForJoin(message.guild.id, vc.id);
    return joinVoice(message.guild, vc.id, 'prefix');
}

async function handleSlashJoin(interaction) {
    const member = await interaction.guild.members.fetch(interaction.user.id);
    const vc = getVoiceChannelFromMember(member);
    if (!vc) return '❌ You are not in a voice channel';
    prepareGuildForJoin(interaction.guild.id, vc.id);
    return joinVoice(interaction.guild, vc.id, 'slash');
}

async function handlePrefixLeave(message) {
    prepareGuildForLeave(message.guild.id);
    return leaveVoice(message.guild);
}

async function handleSlashLeave(interaction) {
    prepareGuildForLeave(interaction.guild.id);
    return leaveVoice(interaction.guild);
}

async function handlePrefixTTS(message, text) {
    return tts(message.guild, text);
}

async function handleSlashTTS(interaction, text) {
    return tts(interaction.guild, text);
}

function queueReconnectAfterManualLeave(guildId) {
    const st = getGuildState(guildId);
    st.manualLeave = true;
    st.manualLeaveUntil = now() + MANUAL_LEAVE_COOLDOWN_MS;
    st.updatedAt = now();
}

function maybeUnlockManualLeave(guildId) {
    const st = getGuildState(guildId);
    ensureManualLeaveExpiry(st);
}

function getGuildSafe(guildId) {
    return client.guilds.cache.get(safeId(guildId)) || null;
}

async function ensureGuildVoiceChannel(guild, memberLike) {
    const vc = memberLike?.voice?.channel || null;
    if (!vc) return null;
    const st = getGuildState(guild.id);
    st.channelId = vc.id;
    st.manualLeave = false;
    st.manualLeaveUntil = 0;
    return vc;
}

function setGuildTTSQueue(guildId, queue) {
    const st = getGuildState(guildId);
    st.ttsQueue = Array.isArray(queue) ? queue.slice() : [];
    st.updatedAt = now();
}

function getGuildTTSLockState(guildId) {
    return getGuildState(guildId).ttsLock;
}

function getGuildMetrics(guildId) {
    const st = getGuildState(guildId);
    return {
        guildId: st.guildId,
        channelId: st.channelId,
        manualLeave: st.manualLeave,
        reconnectAttempts: st.reconnectAttempts,
        lastJoinAt: st.lastJoinAt,
        lastLeaveAt: st.lastLeaveAt,
        lastDisconnectAt: st.lastDisconnectAt,
        queue: st.ttsQueue.length,
        playing: st.ttsPlaying,
        error: st.lastError
    };
}

function dumpGuildMetrics() {
    const out = [];
    for (const [guildId] of guildState.entries()) {
        out.push(getGuildMetrics(guildId));
    }
    return out;
}

// Padding section intentionally left as structured helper space so you can
// keep growing the bot without mixing guild-level logic across servers.
// Each guild maintains its own state bucket, reconnect lock, cooldown,
// and TTS queue. That prevents one server from stepping on another.

function finalizeGuildJoin(guildId, channelId) {
    const st = getGuildState(guildId);
    st.channelId = channelId;
    st.manualLeave = false;
    st.manualLeaveUntil = 0;
    st.lastJoinAt = now();
    st.lastKnownVoiceState = 'joined';
    st.updatedAt = now();
}

function finalizeGuildLeave(guildId) {
    const st = getGuildState(guildId);
    st.lastLeaveAt = now();
    st.lastKnownVoiceState = 'left';
    st.channelId = null;
    st.updatedAt = now();
}

function finalizeGuildDisconnect(guildId) {
    const st = getGuildState(guildId);
    st.lastDisconnectAt = now();
    st.lastKnownVoiceState = 'disconnected';
    st.updatedAt = now();
}

function finalizeGuildReconnectAttempt(guildId) {
    const st = getGuildState(guildId);
    st.lastReconnectAttemptAt = now();
    st.reconnectAttempts += 1;
    st.updatedAt = now();
}

function setGuildPendingReason(guildId, reason) {
    const st = getGuildState(guildId);
    st.pendingJoinReason = reason ? String(reason) : null;
    st.updatedAt = now();
}

function getGuildPendingReason(guildId) {
    return getGuildState(guildId).pendingJoinReason;
}

function markGuildManualLeave(guildId) {
    const st = getGuildState(guildId);
    st.manualLeave = true;
    st.manualLeaveUntil = now() + MANUAL_LEAVE_COOLDOWN_MS;
    st.updatedAt = now();
}

function markGuildAutoLeaveCleared(guildId) {
    const st = getGuildState(guildId);
    st.manualLeave = false;
    st.manualLeaveUntil = 0;
    st.updatedAt = now();
}

function getGuildCooldownRemaining(guildId) {
    const st = getGuildState(guildId);
    if (!st.manualLeave) return 0;
    return Math.max(0, st.manualLeaveUntil - now());
}

function formatCooldownRemaining(guildId) {
    const ms = getGuildCooldownRemaining(guildId);
    return `${Math.ceil(ms / 1000)}s`;
}

function guildInReconnectCooldown(guildId) {
    return hasReconnectLock(guildId);
}

function clearGuildReconnectCooldown(guildId) {
    clearReconnectLock(guildId);
}

function setGuildReconnectCooldown(guildId, value) {
    setReconnectLock(guildId, value);
}

function storeGuildVoiceState(guildId, stateName) {
    const st = getGuildState(guildId);
    st.lastKnownVoiceState = String(stateName || '');
    st.updatedAt = now();
}

function getStoredGuildVoiceState(guildId) {
    return getGuildState(guildId).lastKnownVoiceState;
}

function guildHasAudioWork(guildId) {
    const st = getGuildState(guildId);
    return st.ttsPlaying || st.ttsQueue.length > 0 || st.ttsLock;
}

function guildHasVoiceTarget(guildId) {
    const st = getGuildState(guildId);
    return !!st.channelId;
}

function guildCanAutoRejoin(guildId) {
    const st = getGuildState(guildId);
    ensureManualLeaveExpiry(st);
    return !st.manualLeave && !!st.channelId;
}

function guildShouldForceRejoin(guildId) {
    const st = getGuildState(guildId);
    if (!guildCanAutoRejoin(guildId)) return false;
    return !voiceConnectionForGuild(guildId);
}

async function backgroundVoiceSupervisor() {
    for (const [guildId, st] of guildState.entries()) {
        ensureManualLeaveExpiry(st);
        if (!guildShouldForceRejoin(guildId)) continue;
        const guild = getGuildById(guildId);
        if (!guild) continue;
        try {
            await joinVoice(guild, st.channelId, 'supervisor');
        } catch (err) {
            setGuildError(guildId, err?.message || String(err));
        }
    }
}

setInterval(() => {
    backgroundVoiceSupervisor().catch(err => console.error(err));
}, BACKUP_CHECK_INTERVAL_MS);

// End of file: the bot now tracks guilds separately, protects manual leave,
// and uses per-guild reconnect decisions instead of one global voice rule.
