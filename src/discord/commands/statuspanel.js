/**
 * /statuspanel — Creates a dedicated status panel channel with live-updating embeds.
 * Shows each online bot with their skin head, playtime, and IGN.
 * Updates every 5 minutes automatically.
 *
 * Auto-discovers existing panel channel by name on startup — no config file needed.
 */

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ChannelType,
  PermissionFlagsBits,
} = require('discord.js');
const botManager = require('../../minecraft/botManager');
const logger = require('../../utils/logger');

const PANEL_CHANNEL_NAME = '📊│status-panel';

/**
 * Builds the status panel embeds showing all online bots.
 */
function buildPanelEmbeds() {
  const statuses = botManager.getAllStatuses();
  const onlineBots = statuses.filter(
    (s) => s.status !== 'offline' && s.status !== 'connecting'
  );

  if (onlineBots.length === 0) {
    const embed = new EmbedBuilder()
      .setTitle('📊 Status Panel')
      .setDescription('No bots are currently online.')
      .setColor(0x2b2d31)
      .setTimestamp()
      .setFooter({ text: 'Updates every 5 minutes' });
    return [embed];
  }

  const embeds = [];

  // Header embed
  const header = new EmbedBuilder()
    .setTitle('📊 Status Panel')
    .setDescription(`**${onlineBots.length}** account(s) online`)
    .setColor(0x5865f2)
    .setTimestamp()
    .setFooter({ text: 'Updates every 5 minutes' });
  embeds.push(header);

  // One embed per online bot (with skin thumbnail)
  for (const info of onlineBots) {
    const statusEmoji = {
      online: '🟢',
      afk: '💤',
      awaiting_auth: '🔑',
      reconnecting: '🟠',
    }[info.status] || '⚪';

    const username = info.username || info.account;
    const skinUrl = `https://mc-heads.net/avatar/${username}/128`;

    const embed = new EmbedBuilder()
      .setColor(info.status === 'afk' ? 0x57f287 : 0x5865f2)
      .setThumbnail(skinUrl)
      .addFields(
        {
          name: 'Playtime',
          value: info.playtime || 'N/A',
          inline: true,
        },
        {
          name: 'Shards',
          value: info.shards || 'N/A',
          inline: true,
        },
        {
          name: 'Status',
          value: `${statusEmoji} ${info.status}`,
          inline: true,
        }
      )
      .setAuthor({
        name: username,
        iconURL: skinUrl,
      });

    embeds.push(embed);
  }

  return embeds;
}

/**
 * Finds the status panel channel in a guild by name.
 * @param {import('discord.js').Guild} guild
 * @returns {import('discord.js').TextChannel|null}
 */
function findPanelChannel(guild) {
  if (!guild) return null;
  return guild.channels.cache.find(
    (ch) => ch.name === PANEL_CHANNEL_NAME.replace(/[^a-z0-9-│]/gi, '') || ch.name === PANEL_CHANNEL_NAME
  ) || null;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('statuspanel')
    .setDescription('Creates a live-updating status panel channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const guild = interaction.guild;
    if (!guild) {
      return interaction.editReply('❌ This command can only be used in a server.');
    }

    // Check if the panel channel already exists
    // Discord normalizes channel names — search with both raw and normalized names
    const existing = guild.channels.cache.find(
      (ch) => ch.type === ChannelType.GuildText && ch.name.includes('status-panel')
    );

    if (existing) {
      return interaction.editReply(
        `⚠️ Status panel channel already exists: <#${existing.id}>\nThe bot will automatically update it every 5 minutes.\nDelete the channel if you want to recreate it.`
      );
    }

    // Create the channel
    let panelChannel;
    try {
      panelChannel = await guild.channels.create({
        name: '📊│status-panel',
        type: ChannelType.GuildText,
        topic: 'Live bot status panel — updates every 5 minutes',
        reason: 'Status panel created by /statuspanel command',
      });
    } catch (err) {
      return interaction.editReply(`❌ Failed to create channel: ${err.message}`);
    }

    // Build and send the initial embeds
    const embeds = buildPanelEmbeds();
    try {
      await panelChannel.send({ embeds });
    } catch (err) {
      return interaction.editReply(`❌ Failed to send panel message: ${err.message}`);
    }

    return interaction.editReply(
      `✅ Status panel created: <#${panelChannel.id}>\nIt will update automatically every 5 minutes.`
    );
  },

  // Export helpers for use by client.js
  buildPanelEmbeds,
  PANEL_CHANNEL_NAME,
};
