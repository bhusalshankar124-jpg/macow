const { SlashCommandBuilder } = require('discord.js');
const botManager = require('../../minecraft/botManager');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('reconnect')
    .setDescription('Force reconnects the specified Minecraft account(s)')
    .addStringOption((option) =>
      option
        .setName('account')
        .setDescription('Account name or "all" (default: all)')
        .setRequired(false)
    ),

  async execute(interaction) {
    await interaction.deferReply();

    const accountParam = interaction.options.getString('account') || 'all';
    const names = botManager.resolveAccounts(accountParam);

    if (names.length === 0) {
      return interaction.editReply({ content: '❌ No matching accounts found.' });
    }

    const results = await Promise.all(names.map((n) => botManager.reconnectBot(n)));
    return interaction.editReply({ content: results.join('\n') });
  },
};
