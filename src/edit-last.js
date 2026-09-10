const {
  Client,
  PermissionFlagsBits,
  EmbedBuilder,
  ChannelType,
} = require('discord.js');

const { getTicketByChannel } = require('./store');

const GUILD_ID = process.env.DISCORD_GUILD_ID;
const SUPPORT_ROLE_IDS = String(process.env.SUPPORT_ROLE_IDS || '')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);

function isSupportMember(member) {
  if (!member) return false;
  if (member.permissions?.has(PermissionFlagsBits.ManageChannels)) return true;
  return SUPPORT_ROLE_IDS.some(roleId => member.roles?.cache?.has(roleId));
}

function isOutgoingTicketReply(message) {
  if (!message?.author?.bot || !message.embeds?.length) return false;

  const authorName = message.embeds[0]?.author?.name || '';
  return (
    authorName.endsWith('• Direct Reply') ||
    authorName.endsWith('• Anonymous Reply')
  );
}

async function findLatestOutgoingReply(channel) {
  const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  if (!recent) return null;

  return [...recent.values()]
    .filter(isOutgoingTicketReply)
    .sort((a, b) => b.createdTimestamp - a.createdTimestamp)[0] || null;
}

async function findMatchingCustomerDm(client, ticket, ticketLogMessage) {
  const customer = await client.users.fetch(ticket.userId).catch(() => null);
  if (!customer) return null;

  const dmChannel = await customer.createDM().catch(() => null);
  if (!dmChannel) return null;

  const recent = await dmChannel.messages.fetch({ limit: 100 }).catch(() => null);
  if (!recent) return null;

  const ticketEmbed = ticketLogMessage.embeds?.[0];
  const targetDescription = ticketEmbed?.description || '';
  const targetTimestamp = ticketLogMessage.createdTimestamp;

  const candidates = [...recent.values()]
    .filter(dmMessage => {
      if (dmMessage.author?.id !== client.user.id) return false;
      if (!dmMessage.embeds?.length) return false;

      const dmEmbed = dmMessage.embeds[0];
      const dmAuthorName = dmEmbed?.author?.name || '';
      const looksLikeSupportReply =
        dmAuthorName === 'Hashwear Support' ||
        dmAuthorName.endsWith('• Support');

      return looksLikeSupportReply && dmEmbed.description === targetDescription;
    })
    .sort((a, b) => {
      const aDistance = Math.abs(a.createdTimestamp - targetTimestamp);
      const bDistance = Math.abs(b.createdTimestamp - targetTimestamp);
      return aDistance - bDistance;
    });

  return candidates[0] || null;
}

async function handleEditCommand(client, message) {
  if (!message.guild || message.guild.id !== GUILD_ID) return;
  if (message.author.bot) return;

  const match = message.content.trim().match(/^\.edit(?:\s+([\s\S]+))?$/i);
  if (!match) return;

  const ticket = getTicketByChannel(message.channelId);
  if (!ticket || ticket.status !== 'open') return;

  if (!isSupportMember(message.member)) {
    await message.reply('This command is only available to Hashwear support staff.');
    return;
  }

  const newText = (match[1] || '').trim();
  if (!newText) {
    await message.reply('Usage: `.edit corrected message`');
    return;
  }

  const ticketLogMessage = await findLatestOutgoingReply(message.channel);
  if (!ticketLogMessage) {
    await message.reply('There is no previous support reply to edit in this ticket.');
    return;
  }

  const customerDmMessage = await findMatchingCustomerDm(
    client,
    ticket,
    ticketLogMessage
  );

  if (!customerDmMessage) {
    await message.reply('I could not find the matching message in the customer DM to edit.');
    return;
  }

  try {
    const customerEmbed = EmbedBuilder.from(customerDmMessage.embeds[0])
      .setDescription(newText);

    const ticketEmbed = EmbedBuilder.from(ticketLogMessage.embeds[0])
      .setDescription(newText);

    await customerDmMessage.edit({ embeds: [customerEmbed] });
    await ticketLogMessage.edit({ embeds: [ticketEmbed] });

    // Keep ticket channels clean. The updated boxed reply itself is the confirmation.
    await message.delete().catch(() => {});
  } catch (error) {
    console.error('Edit last support reply failed:', error);
    await message.reply('I could not edit the last support reply. Please try again.');
  }
}

async function updateCommandGuide(client) {
  if (!GUILD_ID) return;

  // Let the main bot finish creating/updating the guide first.
  await new Promise(resolve => setTimeout(resolve, 2500));

  const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
  if (!guild) return;

  const channel = guild.channels.cache.find(ch =>
    ch.type === ChannelType.GuildText && ch.name === 'support-commands'
  );
  if (!channel) return;

  const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  if (!recent) return;

  const guideMessage = [...recent.values()].find(msg =>
    msg.author.id === client.user.id &&
    msg.embeds?.[0]?.title === 'Hashwear Support — Staff Commands'
  );
  if (!guideMessage) return;

  const guideEmbed = EmbedBuilder.from(guideMessage.embeds[0]);
  const currentFields = guideMessage.embeds[0].fields || [];

  if (!currentFields.some(field => field.name === 'Edit Last Reply')) {
    guideEmbed.addFields({
      name: 'Edit Last Reply',
      value: '`.edit corrected message`\nEdits the most recent `.areply` or `.reply` sent to the customer and updates the matching boxed reply in the ticket.',
      inline: false,
    });

    await guideMessage.edit({ embeds: [guideEmbed] }).catch(error => {
      console.error('Could not add .edit to support command guide:', error);
    });
  }
}

const originalLogin = Client.prototype.login;

Client.prototype.login = function patchedLogin(...args) {
  this.on('messageCreate', message => {
    handleEditCommand(this, message).catch(error => {
      console.error('Edit command handler failed:', error);
    });
  });

  this.once('ready', () => {
    updateCommandGuide(this).catch(error => {
      console.error('Support command guide edit update failed:', error);
    });
  });

  return originalLogin.apply(this, args);
};
