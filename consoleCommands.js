const { joinVoice, leaveVoice } = require('./voice');

async function handleConsoleCommand(client, line) {

    const args = line.split(" ");
    const command = args.shift().toLowerCase();

    const guild = client.guilds.cache.first();
    if (!guild) return console.log("No guild");

    try {

        switch (command) {

            case "join":
                if (!args[0])
                    return console.log("Usage: join CHANNEL_ID");

                await joinVoice(client, args[0]);
                break;

            case "leave":
                leaveVoice(client);
                break;

            case "undeafen": {
                const me = await guild.members.fetch(client.user.id);
                await me.voice.setDeaf(false);
                console.log("Bot undeafened itself");
                break;
            }

            case "deafen": {
                const me = await guild.members.fetch(client.user.id);
                await me.voice.setDeaf(true);
                console.log("Bot deafened itself");
                break;
            }

            case "unmute": {
                const me = await guild.members.fetch(client.user.id);
                await me.voice.setMute(false);
                console.log("Bot unmuted itself");
                break;
            }

            case "mute": {
                const me = await guild.members.fetch(client.user.id);
                await me.voice.setMute(true);
                console.log("Bot muted itself");
                break;
            }

            case "say": {
                const text = args.join(" ");
                if (!text) return;

                const channel = guild.channels.cache.find(
                    c => c.isTextBased()
                );

                if (channel) {
                    await channel.send(text);
                    console.log("Message sent");
                }
                break;
            }

            default:
                console.log("Unknown command");
        }

    } catch (err) {
        console.log("Error executing command:", err);
    }
}

module.exports = { handleConsoleCommand };