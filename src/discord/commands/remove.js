const { SlashCommandBuilder } = require('discord.js');
const botManager = require('../../minecraft/botManager');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Removes an account — stops the bot, clears auth tokens, and deletes from accounts.json')
    .addStringOption((option) =>
      option
        .setName('account')
        .setDescription('Account name to remove')
        .setRequired(true)
    ),

  async execute(interaction) {
    const accountName = interaction.options.getString('account');

    const result = botManager.removeAccount(accountName);
    return interaction.reply({ content: result });
  },
};
