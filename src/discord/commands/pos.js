const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const botManager = require('../../minecraft/botManager');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('pos')
    .setDescription('Shows coordinates of the specified account')
    .addStringOption((option) =>
      option
        .setName('account')
        .setDescription('Account name (shows all if omitted)')
        .setRequired(false)
    ),

  async execute(interaction) {
    const accountParam = interaction.options.getString('account') || 'all';
    const names = botManager.resolveAccounts(accountParam);
    const statuses = names.map((n) => botManager.getStatus(n)).filter(Boolean);

    if (statuses.length === 0) {
      return interaction.reply({ content: '❌ No matching accounts found.', ephemeral: true });
    }

    const embed = new EmbedBuilder()
      .setTitle('📍 Bot Positions')
      .setColor(0x57f287)
      .setTimestamp();

    for (const info of statuses) {
      const pos = info.position
        ? `\`X: ${info.position.x}\` \`Y: ${info.position.y}\` \`Z: ${info.position.z}\``
        : '❓ Position unavailable (bot offline)';

      embed.addFields({
        name: info.account,
        value: pos,
        inline: true,
      });
    }

    return interaction.reply({ embeds: [embed] });
  },
};
