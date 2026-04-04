const { Client, GatewayIntentBits } = require('discord.js');
const { joinVoiceChannel, getVoiceConnection, createAudioPlayer, createAudioResource, StreamType, entersState, VoiceConnectionStatus } = require('@discordjs/voice');
const fs = require('fs');
const gTTS = require('google-tts-api');

// CONFIG
const TOKEN = "MTQ5MDA1MTAzMzgxMDg2NjM4Nw.GXZovC.IHa4Dz6V9zx5Meq2D8PnCkq7_InfG_N79uLoRM";
const GUILD_ID = "1400867238717689897";
const VOICE_CHANNEL_ID = "1429538224966992013";
const TEXT_CHANNEL_ID = "1429538224966992013";
const OWNER_ID = "840259968367591454";

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages]
});

let callTimes = {};
if (fs.existsSync('callTimes.json')) callTimes = JSON.parse(fs.readFileSync('callTimes.json', 'utf-8'));

const player = createAudioPlayer();

// ------------------ FUNCTIONS ------------------
async function joinVC() {
  const guild = await client.guilds.fetch(GUILD_ID);
  const channel = await guild.channels.fetch(VOICE_CHANNEL_ID);
  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfMute: false,
    selfDeaf: false
  });
  await entersState(connection, VoiceConnectionStatus.Ready, 15000);
  connection.subscribe(player);
}

function leaveVC() {
  const connection = getVoiceConnection(GUILD_ID);
  if(connection) connection.destroy();
}

async function say(message) {
  const channel = await client.channels.fetch(TEXT_CHANNEL_ID);
  if(channel.isTextBased()) await channel.send(message);
}

async function tts(message) {
  const connection = getVoiceConnection(GUILD_ID);
  if(!connection) return console.log("Bot not in VC");
  const url = gTTS.getAudioUrl(message, { lang: 'en', slow: false, host: 'https://translate.google.com' });
  const resource = createAudioResource(url, { inputType: StreamType.Arbitrary });
  player.play(resource);
}

async function mention(userId, message) {
  const channel = await client.channels.fetch(TEXT_CHANNEL_ID);
  if(channel.isTextBased()) await channel.send(`<@${userId}> ${message}`);
}

async function addRole(userId, roleId) {
  if(OWNER_ID !== OWNER_ID) return console.log("Unauthorized");
  const guild = await client.guilds.fetch(GUILD_ID);
  const member = await guild.members.fetch(userId);
  const role = await guild.roles.fetch(roleId);
  if(member && role) await member.roles.add(role);
}

async function removeRole(userId, roleId) {
  if(OWNER_ID !== OWNER_ID) return console.log("Unauthorized");
  const guild = await client.guilds.fetch(GUILD_ID);
  const member = await guild.members.fetch(userId);
  const role = await guild.roles.fetch(roleId);
  if(member && role) await member.roles.remove(role);
}

async function unban(userId) {
  if(OWNER_ID !== OWNER_ID) return console.log("Unauthorized");
  const guild = await client.guilds.fetch(GUILD_ID);
  const bans = await guild.bans.fetch();
  if(bans.has(userId)) await guild.members.unban(userId, "Unbanned via UI");
}

// Track call times
client.on('voiceStateUpdate', (oldState, newState) => {
  const userId = newState.id;
  if(!oldState.channelId && newState.channelId) callTimes[userId] = Date.now();
  if(oldState.channelId && !newState.channelId && callTimes[userId]) {
    const timeSpentMs = Date.now() - callTimes[userId];
    console.log(`${oldState.member.user.username} spent ${Math.floor(timeSpentMs/60000)} min(s)`);
    delete callTimes[userId];
    fs.writeFileSync('callTimes.json', JSON.stringify(callTimes, null, 2));
  }
});

// ------------------ START BOT ------------------
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await joinVC();
});

client.login(TOKEN);

// ------------------ EXPORT FUNCTIONS ------------------
module.exports = {
  joinVC, leaveVC, say, tts, mention,
  addRole, removeRole, unban
};