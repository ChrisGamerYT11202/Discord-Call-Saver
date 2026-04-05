// server.js
const express = require('express');
const app = express();
const path = require('path');

// Serve a tiny dashboard (optional)
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

// Keep server running
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Web server running on port ${PORT}`));

// ---- Your Bot Code ----
const { Client, GatewayIntentBits } = require('discord.js');
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
  ],
});

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

// Replace this with your command handling / TTS / roles / etc.
client.on('messageCreate', message => {
  if (message.author.bot) return;
  if (message.content === '!ping') message.channel.send('Pong!');
});

// Login using token from environment variable
client.login(process.env.BOT_TOKEN);