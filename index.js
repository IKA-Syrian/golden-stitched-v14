
const { Client, GatewayIntentBits, REST, Routes, AttachmentBuilder } = require('discord.js');
const fs = require('fs');
require('dotenv').config();
const commandsData = require('./Commands/index')
const stitcher = require('./stitch-system')
const {TOKEN, CLIENT_ID, Guild_ID} = process.env
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent,] });
const rest = new REST({ version: '10' }).setToken(TOKEN);
client.on('ready', () => {
    console.log(`Logged in as ${client.user.tag}!`);
    stitcher(client)
    // trackingCommands(client)
});

// client.on('interactionCreate', async interaction => {
//     if (!interaction.isCommand()) return;
//     const { commandName } = interaction;
//     if(commandName == 'stitch'){
//         // commandsData.Stitch.callback(interaction)
//     }
// });
async function main() {
    const commands = [
        commandsData.Stitch
    ];
    try{
        console.log('Started refreshing application (/) commands.');
        // Routes.registerApplicationCommands(client, commands);
        await rest.put(Routes.applicationGuildCommands(CLIENT_ID, Guild_ID), { body: commands });
    
        console.log('Successfully reloaded application (/) commands.');

        client.login(TOKEN);
    }catch(err){
        console.error(err);
    }
}

main();
