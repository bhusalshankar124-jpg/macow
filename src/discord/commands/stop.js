const { SlashCommandBuilder } = require('discord.js');
const botManager = require('../../minecraft/botManager');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Disconnects the specified Minecraft account(s)')
    .addStringOption((option) =>
      option
        .setName('account')
        .setDescription('Account name or "all" (default: all)')
        .setRequired(false)
    ),

  async execute(interaction) {
    const accountParam = interaction.options.getString('account') || 'all';
    const names = botManager.resolveAccounts(accountParam);

    if (names.length === 0) {
      return interaction.reply({ content: '❌ No matching accounts found.', ephemeral: true });
    }

    const results = names.map((n) => botManager.stopBot(n));
    return interaction.reply({ content: results.join('\n') });
  },
};
