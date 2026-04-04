// server.js
const express = require('express');
const path = require('path');
const { Client, GatewayIntentBits } = require('discord.js');

// --- Tiny web server ---
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Web server running on port ${PORT}`));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

// --- Discord Bot ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent
  ]
});

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

// Example command: ping
client.on('messageCreate', message => {
  if (message.author.bot) return;
  if (message.content === '!ping') message.channel.send('Pong!');
});

// Login using token from environment variable
client.login(process.env.BOT_TOKEN);
