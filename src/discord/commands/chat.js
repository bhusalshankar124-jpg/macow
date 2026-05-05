const { SlashCommandBuilder } = require('discord.js');
const botManager = require('../../minecraft/botManager');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('chat')
    .setDescription('Sends a chat message from a specific Minecraft account')
    .addStringOption((option) =>
      option
        .setName('account')
        .setDescription('Account name to send the message from')
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName('message')
        .setDescription('The message to send in Minecraft chat')
        .setRequired(true)
    ),

  async execute(interaction) {
    const accountName = interaction.options.getString('account');
    const message = interaction.options.getString('message');

    const result = botManager.chat(accountName, message);
    return interaction.reply({ content: result });
  },
};
