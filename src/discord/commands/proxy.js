/**
 * /proxy — Manage proxies at runtime via slash commands.
 * Supports: add, remove, list, clear
 */

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const botManager = require('../../minecraft/botManager');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('proxy')
    .setDescription('Manage proxies for bot connections')
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Add a proxy (format: host:port:user:pass or socks5://user:pass@host:port)')
        .addStringOption((opt) =>
          opt.setName('proxy').setDescription('Proxy string').setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Remove a proxy by its index number')
        .addIntegerOption((opt) =>
          opt
            .setName('index')
            .setDescription('Proxy index (from /proxy list)')
            .setRequired(true)
            .setMinValue(1)
        )
    )
    .addSubcommand((sub) =>
      sub.setName('list').setDescription('List all current proxies')
    )
    .addSubcommand((sub) =>
      sub.setName('clear').setDescription('Remove all proxies')
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'add') {
      const proxyStr = interaction.options.getString('proxy');
      const result = botManager.addProxy(proxyStr);
      return interaction.reply({ content: result, ephemeral: true });
    }

    if (sub === 'remove') {
      const index = interaction.options.getInteger('index');
      const result = botManager.removeProxy(index - 1); // Convert 1-based to 0-based
      return interaction.reply({ content: result, ephemeral: true });
    }

    if (sub === 'list') {
      const proxies = botManager.getProxiesMasked();
      const accountNames = botManager.getAllAccountNames();
      const perProxy = botManager.accountsPerProxy;

      if (proxies.length === 0) {
        return interaction.reply({
          content: '📭 No proxies configured. Use `/proxy add` to add one.',
          ephemeral: true,
        });
      }

      const embed = new EmbedBuilder()
        .setTitle('🌐 Proxy List')
        .setColor(0x5865f2)
        .setTimestamp()
        .setFooter({ text: `${perProxy} account(s) per proxy` });

      for (let i = 0; i < proxies.length; i++) {
        // Calculate which accounts are assigned to this proxy
        const startIdx = i * perProxy;
        const endIdx = Math.min(startIdx + perProxy, accountNames.length);
        const assignedAccounts =
          startIdx < accountNames.length
            ? accountNames.slice(startIdx, endIdx).join(', ')
            : 'none';

        embed.addFields({
          name: `#${i + 1} — ${proxies[i]}`,
          value: `**Accounts:** ${assignedAccounts}`,
          inline: false,
        });
      }

      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (sub === 'clear') {
      const result = botManager.clearProxies();
      return interaction.reply({ content: result, ephemeral: true });
    }
  },
};
