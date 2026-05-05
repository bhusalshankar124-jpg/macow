const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const botManager = require('../../minecraft/botManager');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('debug')
    .setDescription('Dumps all scoreboard/tab/team data from a bot for debugging')
    .addStringOption(function (option) {
      return option
        .setName('account')
        .setDescription('Account name to debug')
        .setRequired(true);
    }),

  async execute(interaction) {
    var accountName = interaction.options.getString('account');
    var state = botManager.bots.get(accountName);

    if (!state || !state.bot) {
      return interaction.reply({ content: '❌ **' + accountName + '** is not online.', ephemeral: true });
    }

    await interaction.deferReply();

    var bot = state.bot;
    var lines = [];

    // Scoreboard data
    lines.push('**📊 Scoreboard Data:**');
    if (bot.scoreboard) {
      for (var pos = 0; pos <= 18; pos++) {
        var objective = bot.scoreboard[pos];
        if (!objective) continue;

        var title = objective.name || 'Unknown';
        var objKeys = Object.keys(objective);
        lines.push('`pos=' + pos + '` Title: `' + title + '` Keys: `' + objKeys.join(', ') + '`');

        // Dump all properties that are arrays or objects
        for (var ki = 0; ki < objKeys.length; ki++) {
          var key = objKeys[ki];
          var val = objective[key];
          if (key === 'displayName' || key === 'name') continue;

          if (Array.isArray(val) && val.length > 0) {
            lines.push('  `' + key + '` (array, ' + val.length + ' items):');
            for (var i = 0; i < Math.min(val.length, 20); i++) {
              var entry = val[i];
              var entryStr = typeof entry === 'object' ? JSON.stringify(entry).substring(0, 200) : String(entry);
              lines.push('    `[' + i + ']` ' + entryStr);
            }
          } else if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
            var subKeys = Object.keys(val);
            if (subKeys.length > 0 && subKeys.length <= 30) {
              lines.push('  `' + key + '` (object, ' + subKeys.length + ' keys):');
              for (var j = 0; j < Math.min(subKeys.length, 20); j++) {
                var subVal = val[subKeys[j]];
                var subStr = typeof subVal === 'object' ? JSON.stringify(subVal).substring(0, 200) : String(subVal);
                lines.push('    `' + subKeys[j] + '` = ' + subStr);
              }
            }
          }
        }
      }
    } else {
      lines.push('No scoreboard data available');
    }

    // Teams
    lines.push('');
    lines.push('**👥 Teams:**');
    if (bot.teams) {
      var teamKeys = Object.keys(bot.teams);
      lines.push(teamKeys.length + ' teams found');
      for (var t = 0; t < Math.min(teamKeys.length, 25); t++) {
        var team = bot.teams[teamKeys[t]];
        var prefix = team.prefix ? JSON.stringify(team.prefix).substring(0, 100) : 'none';
        var suffix = team.suffix ? JSON.stringify(team.suffix).substring(0, 100) : 'none';
        var members = team.members ? team.members.join(', ') : 'none';
        lines.push('`' + teamKeys[t] + '` prefix=' + prefix + ' suffix=' + suffix + ' members=' + members);
      }
    } else {
      lines.push('No teams data');
    }

    // Current state
    lines.push('');
    lines.push('**📈 Parsed Stats:**');
    lines.push('Playtime: `' + (state.playtime || 'N/A') + '`');
    lines.push('Shards: `' + (state.shards || 'N/A') + '`');

    var content = lines.join('\n');
    // Discord message limit is 2000 chars
    if (content.length > 1900) {
      content = content.substring(0, 1900) + '\n... (truncated)';
    }

    return interaction.editReply({ content: content });
  },
};
