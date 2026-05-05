const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const botManager = require('../../minecraft/botManager');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('buyspawners')
    .setDescription('Buys skeleton spawner(s) and sends a TPA request')
    .addStringOption((option) =>
      option
        .setName('account')
        .setDescription('Minecraft bot account to buy from')
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName('target_user')
        .setDescription('Username to send the TPA request to')
        .setRequired(true)
    )
    .addIntegerOption((option) =>
      option
        .setName('count')
        .setDescription('Number of spawners to buy (default: 1)')
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(20)
    ),

  async execute(interaction) {
    await interaction.deferReply();

    const accountName = interaction.options.getString('account');
    const targetUser = interaction.options.getString('target_user');
    const count = interaction.options.getInteger('count') || 1;

    const result = await botManager.buySpawners(accountName, targetUser, count);

    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`buy_spawner_${accountName}_${targetUser}_${count}`)
          .setLabel(`Buy ${count}x Again`)
          .setStyle(ButtonStyle.Primary)
          .setEmoji('🛒'),
      );

    return interaction.editReply({ content: result, components: [row] });
  },
};
