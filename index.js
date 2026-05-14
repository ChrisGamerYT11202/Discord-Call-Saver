require('dotenv').config();

const {
    Client,
    GatewayIntentBits,
    Partials,
    ChannelType
} = require('discord.js');

const {
    joinVoiceChannel,
    getVoiceConnection
} = require('@discordjs/voice');

const express = require('express');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates
    ],
    partials: [Partials.Channel]
});

const PREFIX = "!";
const TOKEN = process.env.BOT_TOKEN;

let lastVoiceChannelId = null;
let lastGuildId = null;

// =======================
// JOIN FUNCTION
// =======================

async function joinVoice(guild, channelId) {

    const channel = guild.channels.cache.get(channelId);
    if (!channel) return "Channel not found";

    const connection = joinVoiceChannel({
        channelId,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: false
    });

    lastVoiceChannelId = channelId;
    lastGuildId = guild.id;

    console.log("🎧 Joined VC:", channel.name);

    return "🎧 Joined voice";
}

// =======================
// LEAVE
// =======================

function leaveVoice(guild) {

    const conn = getVoiceConnection(guild.id);
    if (!conn) return "Not in voice";

    conn.destroy();
    return "👋 Left voice";
}

// =======================
// AUTO REJOIN (INSTANT)
// =======================

client.on('voiceStateUpdate', async (oldState, newState) => {

    if (!client.user) return;

    if (
        oldState.member?.id === client.user.id &&
        !newState.channelId
    ) {
        console.log("⚠️ Disconnected — rejoining instantly");

        setTimeout(async () => {
            try {
                const guild = client.guilds.cache.get(lastGuildId);
                if (guild && lastVoiceChannelId)
                    await joinVoice(guild, lastVoiceChannelId);
            } catch {}
        }, 2000);
    }
});

// =======================
// BACKUP 5 MIN CHECK
// =======================

setInterval(async () => {

    const guild = client.guilds.cache.get(lastGuildId);
    if (!guild || !lastVoiceChannelId) return;

    const conn = getVoiceConnection(guild.id);

    if (!conn) {
        console.log("♻️ Backup rejoin triggered");
        await joinVoice(guild, lastVoiceChannelId);
    }

}, 5 * 60 * 1000);

// =======================
// PREFIX COMMANDS
// =======================

client.on('messageCreate', async message => {

    if (!message.guild || message.author.bot) return;
    if (!message.content.startsWith(PREFIX)) return;

    const args = message.content.slice(1).split(/\s+/);
    const cmd = args.shift().toLowerCase();

    if (cmd === "join") {
        const id = args[0];
        return message.reply(await joinVoice(message.guild, id));
    }

    if (cmd === "leave") {
        return message.reply(leaveVoice(message.guild));
    }

    if (cmd === "help") {
        return message.reply("Commands: !join !leave OR /join /leave");
    }
});

// =======================
// SLASH COMMANDS
// =======================

client.on('interactionCreate', async interaction => {

    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "join") {
        const id = interaction.options.getString("channel");
        await interaction.reply(
            await joinVoice(interaction.guild, id)
        );
    }

    if (interaction.commandName === "leave") {
        await interaction.reply(
            leaveVoice(interaction.guild)
        );
    }

    if (interaction.commandName === "help") {
        await interaction.reply(
            "Commands: !join /join !leave /leave"
        );
    }
});

// =======================
// READY AUTO JOIN
// =======================

client.once('clientReady', async () => {

    console.log("✅ Logged in as", client.user.tag);

    const guild = client.guilds.cache.first();
    if (!guild) return;

    const channelId = "1429538224966992013";

    await joinVoice(guild, channelId);
});

// =======================
// LOGIN
// =======================

client.login(TOKEN);

// =======================
// RENDER KEEP ALIVE
// =======================

const app = express();

app.get('/', (_, res) => res.send("Bot alive"));

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () =>
    console.log("🌐 Web server running on port", PORT)
);
