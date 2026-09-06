const http = require('node:http');
const {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  PermissionFlagsBits,
  EmbedBuilder,
} = require('discord.js');

const commands = require('./commands');
const {
  DATA_FILE,
  getTicket,
  getTicketByChannel,
  upsertTicket,
  closeTicket,
  mutateNotifications,
} = require('./store');

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const SUPPORT_CATEGORY_ID = process.env.SUPPORT_CATEGORY_ID;
const SUPPORT_ROLE_IDS = splitIds(process.env.SUPPORT_ROLE_IDS);
const PORT = Number(process.env.PORT || 10000);

if (!TOKEN || !GUILD_ID || !SUPPORT_CATEGORY_ID) {
  console.error('Missing required environment variables: DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, SUPPORT_CATEGORY_ID');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

function splitIds(value) {
  return String(value || '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);
}

function safeChannelName(username) {
  const cleaned = String(username || 'user')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 70);
  return cleaned || 'user';
}

function isSupport(interaction) {
  if (!interaction.inGuild()) return false;
  if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) return true;

  const memberRoles = interaction.member?.roles;
  const roleIds = Array.isArray(memberRoles)
    ? memberRoles
    : memberRoles?.cache
      ? [...memberRoles.cache.keys()]
      : [];

  return SUPPORT_ROLE_IDS.some(id => roleIds.includes(id));
}

function isSupportMember(member) {
  if (!member) return false;
  if (member.permissions?.has(PermissionFlagsBits.ManageChannels)) return true;
  return SUPPORT_ROLE_IDS.some(id => member.roles?.cache?.has(id));
}

function ticketMentions(ticket) {
  const userMentions = (ticket.notifyUserIds || []).map(id => `<@${id}>`);
  const roleMentions = (ticket.notifyRoleIds || []).map(id => `<@&${id}>`);
  return [...userMentions, ...roleMentions];
}

async function fetchGuild() {
  return client.guilds.fetch(GUILD_ID);
}

async function createTicketForUser(user) {
  const guild = await fetchGuild();
  const existing = getTicket(user.id);

  if (existing?.status === 'open') {
    const existingChannel = await guild.channels.fetch(existing.channelId).catch(() => null);
    if (existingChannel) return { ticket: existing, channel: existingChannel, created: false };
  }

  const baseName = safeChannelName(user.username);
  let channelName = baseName;
  const duplicate = guild.channels.cache.some(ch => ch.name === channelName);
  if (duplicate) channelName = `${baseName.slice(0, 90)}-${user.id.slice(-4)}`;

  const permissionOverwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel],
    },
    {
      id: client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.ManageChannels,
      ],
    },
    ...SUPPORT_ROLE_IDS.map(roleId => ({
      id: roleId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.AttachFiles,
      ],
    })),
  ];

  const channel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: SUPPORT_CATEGORY_ID,
    topic: `Hashwear Support ticket | User: ${user.tag} | User ID: ${user.id}`,
    permissionOverwrites,
    reason: `New Hashwear Support DM ticket for ${user.tag}`,
  });

  const ticket = upsertTicket(user.id, {
    userId: user.id,
    username: user.username,
    userTag: user.tag,
    channelId: channel.id,
    status: 'open',
    openedAt: new Date().toISOString(),
    notifyUserIds: [],
    notifyRoleIds: [],
  });

  const intro = new EmbedBuilder()
    .setTitle('New Hashwear Support Ticket')
    .setDescription(`Customer: <@${user.id}>\nDiscord: **${user.tag}**\nUser ID: \`${user.id}\``)
    .addFields(
      { name: 'Anonymous reply', value: '`.areply your message`', inline: false },
      { name: 'Direct reply', value: '`.reply your message` — customer sees your staff name', inline: false },
      { name: 'Notifications', value: '`.notify add-user @user`, `.notify add-role @role`, `.notify list`', inline: false },
      { name: 'Ticket info', value: '`.ticketinfo`', inline: false },
      { name: 'Close', value: '`.close reason`', inline: false },
    )
    .setTimestamp();

  await channel.send({ embeds: [intro] });

  return { ticket, channel, created: true };
}

async function forwardCustomerMessage(message) {
  const user = message.author;
  const { ticket, channel, created } = await createTicketForUser(user);

  if (created) {
    const openedEmbed = new EmbedBuilder()
      .setAuthor({
        name: 'Hashwear Support',
        iconURL: client.user.displayAvatarURL(),
      })
      .setDescription(
        'Hi! Your Hashwear Support ticket has been opened. Tell us your issues with order details and our team will reply in this DM.'
      )
      .setTimestamp();

    await user.send({ embeds: [openedEmbed] }).catch(() => {});
  }

  const content = message.content?.trim() || '*No text — attachment only*';
  const attachments = [...message.attachments.values()];
  const imageAttachment = attachments.find(a => a.contentType?.startsWith('image/'));

  const embed = new EmbedBuilder()
    .setAuthor({
      name: `${user.tag} • Customer`,
      iconURL: user.displayAvatarURL(),
    })
    .setDescription(content.slice(0, 4000))
    .setFooter({ text: `User ID: ${user.id}` })
    .setTimestamp(message.createdAt);

  if (imageAttachment) embed.setImage(imageAttachment.url);
  if (attachments.length) {
    embed.addFields({
      name: 'Attachments',
      value: attachments.map(a => `[${a.name || 'file'}](${a.url})`).join('\n').slice(0, 1000),
    });
  }

  const mentions = ticketMentions(ticket);
  await channel.send({
    content: mentions.length ? mentions.join(' ') : undefined,
    embeds: [embed],
    allowedMentions: {
      users: ticket.notifyUserIds || [],
      roles: ticket.notifyRoleIds || [],
    },
  });
}

async function sendTextReply(message, ticket, direct, replyText) {
  const customer = await client.users.fetch(ticket.userId).catch(() => null);
  if (!customer) {
    await message.reply('I could not find the customer account.');
    return;
  }

  const attachments = [...message.attachments.values()];
  if (!replyText && !attachments.length) {
    await message.reply(`Usage: ${direct ? '.reply' : '.areply'} your message`);
    return;
  }

  const staffName = message.member?.displayName || message.author.globalName || message.author.username;
  const imageAttachment = attachments.find(file => file.contentType?.startsWith('image/'));

  const replyEmbed = new EmbedBuilder()
    .setAuthor({
      name: direct ? `${staffName} • Support` : 'Hashwear Support',
      iconURL: direct ? message.author.displayAvatarURL() : client.user.displayAvatarURL(),
    })
    .setDescription(replyText || '*Attachment*')
    .setTimestamp();

  if (imageAttachment) {
    replyEmbed.setImage(imageAttachment.url);
  }

  const nonImageAttachments = attachments.filter(file => !file.contentType?.startsWith('image/'));
  if (nonImageAttachments.length) {
    replyEmbed.addFields({
      name: 'Attachments',
      value: nonImageAttachments
        .map(file => `[${file.name || 'file'}](${file.url})`)
        .join('\n')
        .slice(0, 1000),
    });
  }

  const dmPayload = {
    embeds: [replyEmbed],
    files: attachments.map(file => file.url),
  };

  try {
    await customer.send(dmPayload);
  } catch (error) {
    console.error('Customer DM failed:', error);
    await message.reply('I could not DM the customer. They may have DMs disabled or blocked the bot.');
    return;
  }

  const confirmation = await message.reply('✅ Reply sent.');
  setTimeout(() => confirmation.delete().catch(() => {}), 2500);
}

async function closeTextTicket(message, ticket, reasonText) {
  const reason = reasonText?.trim() || 'No reason provided';
  const customer = await client.users.fetch(ticket.userId).catch(() => null);

  closeTicket(ticket.userId, message.author.id, reason);

  if (customer) {
    const closedEmbed = new EmbedBuilder()
      .setAuthor({
        name: 'Hashwear Support',
        iconURL: client.user.displayAvatarURL(),
      })
      .setDescription(
        `Your ticket has been closed.\n**Reason:** ${reason}\n\nIf you need help again, just send another DM to this bot and a new ticket will open.`
      )
      .setTimestamp();

    await customer.send({ embeds: [closedEmbed] }).catch(() => {});
  }

  await message.channel.send(`Ticket closed by ${message.author}. Reason: **${reason}**\nThis channel will now be deleted.`);

  setTimeout(() => {
    message.channel.delete(`Ticket closed by ${message.author.tag}: ${reason}`).catch(console.error);
  }, 1500);
}

async function handleNotifyTextCommand(message, ticket, argsText) {
  const parts = argsText.trim().split(/\s+/).filter(Boolean);
  const action = (parts[0] || '').toLowerCase();

  if (!action) {
    await message.reply(
      'Usage: `.notify add-user @user`, `.notify remove-user @user`, `.notify add-role @role`, `.notify remove-role @role`, or `.notify list`'
    );
    return;
  }

  if (action === 'list') {
    const current = getTicket(ticket.userId);
    const users = (current.notifyUserIds || []).map(id => `<@${id}>`).join(', ') || 'None';
    const roles = (current.notifyRoleIds || []).map(id => `<@&${id}>`).join(', ') || 'None';

    await message.reply({
      content: `**Notification users:** ${users}\n**Notification roles:** ${roles}`,
      allowedMentions: { parse: [] },
    });
    return;
  }

  if (action === 'add-user' || action === 'remove-user') {
    const target = message.mentions.users.first();
    if (!target) {
      await message.reply(`Usage: .notify ${action} @user`);
      return;
    }

    mutateNotifications(ticket.userId, current => {
      const set = new Set(current.notifyUserIds || []);
      if (action === 'add-user') set.add(target.id);
      else set.delete(target.id);
      current.notifyUserIds = [...set];
    });

    await message.reply(
      action === 'add-user'
        ? `${target} will now be pinged when this customer messages.`
        : `${target} will no longer be pinged for this ticket.`
    );
    return;
  }

  if (action === 'add-role' || action === 'remove-role') {
    const role = message.mentions.roles.first();
    if (!role) {
      await message.reply(`Usage: .notify ${action} @role`);
      return;
    }

    mutateNotifications(ticket.userId, current => {
      const set = new Set(current.notifyRoleIds || []);
      if (action === 'add-role') set.add(role.id);
      else set.delete(role.id);
      current.notifyRoleIds = [...set];
    });

    await message.reply(
      action === 'add-role'
        ? `${role} will now be pinged when this customer messages.`
        : `${role} will no longer be pinged for this ticket.`
    );
    return;
  }

  await message.reply(
    'Unknown notify action. Use `.notify add-user @user`, `.notify remove-user @user`, `.notify add-role @role`, `.notify remove-role @role`, or `.notify list`.'
  );
}

async function sendTicketInfo(message, ticket) {
  const current = getTicket(ticket.userId);
  const users = (current.notifyUserIds || []).map(id => `<@${id}>`).join(', ') || 'None';
  const roles = (current.notifyRoleIds || []).map(id => `<@&${id}>`).join(', ') || 'None';

  await message.reply({
    content:
      `**Customer:** <@${current.userId}> (${current.userTag})\n` +
      `**User ID:** \`${current.userId}\`\n` +
      `**Opened:** <t:${Math.floor(new Date(current.openedAt).getTime() / 1000)}:R>\n` +
      `**Notify users:** ${users}\n` +
      `**Notify roles:** ${roles}`,
    allowedMentions: { parse: [] },
  });
}

async function handleTicketTextCommand(message) {
  const ticket = getTicketByChannel(message.channelId);
  if (!ticket || ticket.status !== 'open') return false;

  const content = message.content.trim();
  const match = content.match(/^\.(areply|reply|close|notify|ticketinfo)(?:\s+([\s\S]*))?$/i);
  if (!match) return false;

  if (!isSupportMember(message.member)) {
    await message.reply('This command is only available to Hashwear support staff.');
    return true;
  }

  const command = match[1].toLowerCase();
  const text = (match[2] || '').trim();

  if (command === 'areply') {
    await sendTextReply(message, ticket, false, text);
    return true;
  }

  if (command === 'reply') {
    await sendTextReply(message, ticket, true, text);
    return true;
  }

  if (command === 'close') {
    await closeTextTicket(message, ticket, text);
    return true;
  }

  if (command === 'notify') {
    await handleNotifyTextCommand(message, ticket, text);
    return true;
  }

  if (command === 'ticketinfo') {
    await sendTicketInfo(message, ticket);
    return true;
  }

  return false;
}

client.once('ready', async readyClient => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  console.log(`Ticket store: ${DATA_FILE}`);

  try {
    const guild = await readyClient.guilds.fetch(GUILD_ID);
    await guild.commands.set(commands);
    console.log(`Cleared slash commands; Hashwear Support now uses dot commands in ${guild.name}`);
  } catch (error) {
    console.error('Slash command registration failed:', error);
  }
});

client.on('messageCreate', async message => {
  if (message.author.bot) return;

  if (!message.guild) {
    try {
      await forwardCustomerMessage(message);
    } catch (error) {
      console.error('DM ticket handling failed:', error);
      await message.author.send(
        'Hashwear Support could not open your ticket right now. Please try again in a moment.'
      ).catch(() => {});
    }
    return;
  }

  if (message.guild.id !== GUILD_ID) return;

  try {
    await handleTicketTextCommand(message);
  } catch (error) {
    console.error('Ticket text command failed:', error);
    await message.reply('Something went wrong while running that command.').catch(() => {});
  }
});

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    ok: true,
    service: 'Hashwear Support',
    botReady: client.isReady(),
  }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Health server listening on port ${PORT}`);
});

client.login(TOKEN);
