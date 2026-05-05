const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const botManager = require('../../minecraft/botManager');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('status')
    .setDescription('Shows online status, health, hunger, coordinates for bot(s)')
    .addStringOption((option) =>
      option
        .setName('account')
        .setDescription('Account name or "all" (default: all)')
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
      .setTitle('🤖 Bot Status')
      .setColor(0x5865f2)
      .setTimestamp();

    for (const info of statuses) {
      const statusEmoji = {
        offline: '🔴',
        connecting: '🟡',
        awaiting_auth: '🔑',
        online: '🟢',
        afk: '💤',
        reconnecting: '🟠',
      }[info.status] || '⚪';

      const pos = info.position
        ? `X: ${info.position.x} Y: ${info.position.y} Z: ${info.position.z}`
        : 'N/A';

      embed.addFields({
        name: `${statusEmoji} ${info.account}`,
        value: [
          `**Status:** ${info.status}`,
          `**Health:** ${info.health ?? 'N/A'} ❤️ | **Hunger:** ${info.food ?? 'N/A'} 🍗`,
          `**Position:** ${pos}`,
          `**Playtime:** ${info.playtime ?? 'N/A'} ⏱️ | **Shards:** ${info.shards ?? 'N/A'} 💎`,
          `**Reconnect Attempts:** ${info.reconnectAttempts}`,
        ].join('\n'),
        inline: false,
      });
    }

    return interaction.reply({ embeds: [embed] });
  },
};
