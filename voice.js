const { joinVoiceChannel, getVoiceConnection } = require('@discordjs/voice');
const { ChannelType } = require('discord.js');

let connection = null;

async function joinVoice(client, channelId) {
    const guild = client.guilds.cache.first();
    if (!guild) return console.log("No guild");

    const channel = guild.channels.cache.get(channelId);

    if (!channel || channel.type !== ChannelType.GuildVoice)
        return console.log("Invalid voice channel");

    connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false
    });

    console.log(`Joined ${channel.name}`);
}

function leaveVoice(client) {
    const guild = client.guilds.cache.first();
    const conn = getVoiceConnection(guild.id);

    if (conn) {
        conn.destroy();
        console.log("Left voice channel");
    }
}

module.exports = { joinVoice, leaveVoice };