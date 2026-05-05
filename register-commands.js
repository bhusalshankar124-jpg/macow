/**
 * Standalone script to register slash commands with Discord.
 * Run this if commands don't appear: node register-commands.js
 */

require('dotenv').config();

const { REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

async function register() {
  const commandsPath = path.join(__dirname, 'src', 'discord', 'commands');
  const commandFiles = fs.readdirSync(commandsPath).filter((f) => f.endsWith('.js'));

  const commands = [];
  for (const file of commandFiles) {
    const command = require(path.join(commandsPath, file));
    if (command.data) {
      commands.push(command.data.toJSON());
    }
  }

  console.log(`Registering ${commands.length} commands...`);

  try {
    await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID), {
      body: commands,
    });
    console.log(`✅ Successfully registered ${commands.length} slash commands globally!`);
    console.log('Commands:', commands.map((c) => `/${c.name}`).join(', '));
  } catch (err) {
    console.error('❌ Failed:', err.message);
  }
}

register();
