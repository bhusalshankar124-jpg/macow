const { SlashCommandBuilder } = require('discord.js');
const botManager = require('../../minecraft/botManager');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('start')
    .setDescription('Starts and connects the specified Minecraft account(s)')
    .addStringOption((option) =>
      option
        .setName('account')
        .setDescription('Account name or "all" (default: all)')
        .setRequired(false)
    )
    .addBooleanOption((option) =>
      option
        .setName('proxy')
        .setDescription('Use proxy connection (requires PROXY_URL in .env)')
        .setRequired(false)
    ),

  async execute(interaction) {
    await interaction.deferReply();

    const accountParam = interaction.options.getString('account') || 'all';
    const useProxy = interaction.options.getBoolean('proxy') ?? false;
    const names = botManager.resolveAccounts(accountParam);

    if (names.length === 0) {
      return interaction.editReply({ content: '❌ No matching accounts found.' });
    }

    // Single account — start immediately
    if (names.length === 1) {
      const result = botManager.startBot(names[0], useProxy);
      return interaction.editReply({ content: result });
    }

    // Multiple accounts — stagger with 5 min delay between each
    const STAGGER_DELAY = 5 * 60 * 1000; // 5 minutes

    // Start first account immediately
    const firstResult = botManager.startBot(names[0], useProxy);
    await interaction.editReply({
      content: `⏱️ **Staggered start** — ${names.length} accounts, 5 min between each.\n\n` +
        `${firstResult}\n` +
        names.slice(1).map((n, i) => `⏳ **${n}** — starting in ${(i + 1) * 5} min`).join('\n'),
    });

    // Start remaining accounts asynchronously in background (no await to prevent timeout)
    (async () => {
      for (let i = 1; i < names.length; i++) {
        await new Promise((r) => setTimeout(r, STAGGER_DELAY));

        const result = botManager.startBot(names[i], useProxy);
        const remaining = names.slice(i + 1);

        let statusMsg = `⏱️ **Staggered start** — ${names.length} accounts, 5 min between each.\n\n`;
        // Show completed
        for (let j = 0; j <= i; j++) {
          statusMsg += `✅ **${names[j]}** — connecting\n`;
        }
        // Show remaining
        for (let j = 0; j < remaining.length; j++) {
          statusMsg += `⏳ **${remaining[j]}** — starting in ${(j + 1) * 5} min\n`;
        }

        await interaction.editReply({ content: statusMsg }).catch(() => {});
      }

      // Final update — all started
      await interaction.editReply({
        content: `✅ **All ${names.length} accounts started!**\n` +
          names.map((n) => `✅ **${n}** — connecting`).join('\n'),
      }).catch(() => {});
    })();
  },
};
