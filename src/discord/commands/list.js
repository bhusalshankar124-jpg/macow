const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const botManager = require('../../minecraft/botManager');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('list')
    .setDescription('Lists all configured accounts and their current status'),

  async execute(interaction) {
    const statuses = botManager.getAllStatuses();

    if (statuses.length === 0) {
      return interaction.reply({ content: '📋 No accounts configured in accounts.json.', ephemeral: true });
    }

    const embed = new EmbedBuilder()
      .setTitle('📋 Configured Accounts')
      .setColor(0x5865f2)
      .setTimestamp()
      .setFooter({ text: `${statuses.length} account(s) configured` });

    const statusEmojis = {
      offline: '🔴 Offline',
      connecting: '🟡 Connecting',
      awaiting_auth: '🔑 Awaiting Login',
      online: '🟢 Online',
      afk: '💤 AFK',
      reconnecting: '🟠 Reconnecting',
    };

    const lines = statuses.map((info) => {
      const statusText = statusEmojis[info.status] || '⚪ Unknown';
      return `**${info.account}** — ${statusText}`;
    });

    embed.setDescription(lines.join('\n'));

    return interaction.reply({ embeds: [embed] });
  },
};
