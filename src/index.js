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
      { name: 'Anonymous reply', value: '`/areply` — customer sees “Hashwear Support”', inline: false },
      { name: 'Direct reply', value: '`/reply` — customer sees your staff name', inline: false },
      { name: 'Notifications', value: '`/notify add-user`, `/notify add-role`, `/notify list`', inline: false },
      { name: 'Close', value: '`/close`', inline: false },
    )
    .setTimestamp();

  await channel.send({ embeds: [intro] });

  return { ticket, channel, created: true };
}

async function forwardCustomerMessage(message) {
  const user = message.author;
  const { ticket, channel, created } = await createTicketForUser(user);

  if (created) {
    await user.send(
      'Hi! Your Hashwear Support ticket has been opened. Send your issue, screenshots, order details, or follow-up messages here and our team will reply in this DM.'
    ).catch(() => {});
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

async function getTicketContext(interaction) {
  if (!interaction.inGuild()) return { error: 'This command only works inside a Hashwear support ticket.' };
  const ticket = getTicketByChannel(interaction.channelId);
  if (!ticket) return { error: 'This channel is not an active Hashwear support ticket.' };
  return { ticket };
}

async function sendStaffReply(interaction, direct) {
  const ctx = await getTicketContext(interaction);
  if (ctx.error) return interaction.reply({ content: ctx.error, ephemeral: true });

  const message = interaction.options.getString('message')?.trim();
  const file = interaction.options.getAttachment('file');
  if (!message && !file) {
    return interaction.reply({ content: 'Add a message or attachment to send.', ephemeral: true });
  }

  const customer = await client.users.fetch(ctx.ticket.userId).catch(() => null);
  if (!customer) {
    return interaction.reply({ content: 'I could not find the customer account.', ephemeral: true });
  }

  const staffName = interaction.member?.displayName || interaction.user.globalName || interaction.user.username;
  const heading = direct ? `**Reply from ${staffName}:**` : '**Hashwear Support:**';
  const dmPayload = {
    content: `${heading}\n${message || ''}`.trim(),
    files: file ? [file.url] : [],
  };

  try {
    await customer.send(dmPayload);
  } catch (error) {
    console.error('Customer DM failed:', error);
    return interaction.reply({
      content: 'I could not DM the customer. They may have DMs disabled or blocked the bot.',
      ephemeral: true,
    });
  }

  const log = new EmbedBuilder()
    .setAuthor({
      name: `${interaction.user.tag} • Staff`,
      iconURL: interaction.user.displayAvatarURL(),
    })
    .setTitle(direct ? 'Direct reply sent' : 'Anonymous reply sent')
    .setDescription(message || '*Attachment only*')
    .setTimestamp();

  if (file?.contentType?.startsWith('image/')) log.setImage(file.url);
  if (file) log.addFields({ name: 'Attachment', value: `[${file.name || 'file'}](${file.url})` });

  await interaction.reply({ content: 'Reply sent to the customer.', ephemeral: true });
  await interaction.channel.send({ embeds: [log] });
}

async function handleNotify(interaction) {
  const ctx = await getTicketContext(interaction);
  if (ctx.error) return interaction.reply({ content: ctx.error, ephemeral: true });

  const sub = interaction.options.getSubcommand();
  const userId = ctx.ticket.userId;

  if (sub === 'list') {
    const current = getTicket(userId);
    const users = (current.notifyUserIds || []).map(id => `<@${id}>`).join(', ') || 'None';
    const roles = (current.notifyRoleIds || []).map(id => `<@&${id}>`).join(', ') || 'None';
    return interaction.reply({
      content: `**Notification users:** ${users}\n**Notification roles:** ${roles}`,
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
  }

  if (sub === 'add-user' || sub === 'remove-user') {
    const user = interaction.options.getUser('user', true);
    mutateNotifications(userId, ticket => {
      const set = new Set(ticket.notifyUserIds || []);
      if (sub === 'add-user') set.add(user.id);
      else set.delete(user.id);
      ticket.notifyUserIds = [...set];
    });
    return interaction.reply({
      content: sub === 'add-user'
        ? `${user} will now be pinged when this customer messages.`
        : `${user} will no longer be pinged for this ticket.`,
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
  }

  if (sub === 'add-role' || sub === 'remove-role') {
    const role = interaction.options.getRole('role', true);
    mutateNotifications(userId, ticket => {
      const set = new Set(ticket.notifyRoleIds || []);
      if (sub === 'add-role') set.add(role.id);
      else set.delete(role.id);
      ticket.notifyRoleIds = [...set];
    });
    return interaction.reply({
      content: sub === 'add-role'
        ? `${role} will now be pinged when this customer messages.`
        : `${role} will no longer be pinged for this ticket.`,
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
  }
}

async function handleClose(interaction) {
  const ctx = await getTicketContext(interaction);
  if (ctx.error) return interaction.reply({ content: ctx.error, ephemeral: true });

  const reason = interaction.options.getString('reason')?.trim() || 'No reason provided';
  const customer = await client.users.fetch(ctx.ticket.userId).catch(() => null);

  closeTicket(ctx.ticket.userId, interaction.user.id, reason);

  if (customer) {
    await customer.send(
      `**Hashwear Support:** Your ticket has been closed.\nReason: ${reason}\n\nIf you need help again, just send another DM to this bot and a new ticket will open.`
    ).catch(() => {});
  }

  await interaction.reply(`Ticket closed by ${interaction.user}. Reason: **${reason}**\nThis channel will now be deleted.`);

  setTimeout(() => {
    interaction.channel.delete(`Ticket closed by ${interaction.user.tag}: ${reason}`).catch(console.error);
  }, 1500);
}

client.once('ready', async readyClient => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  console.log(`Ticket store: ${DATA_FILE}`);

  try {
    const guild = await readyClient.guilds.fetch(GUILD_ID);
    await guild.commands.set(commands);
    console.log(`Registered ${commands.length} Hashwear Support commands in ${guild.name}`);
  } catch (error) {
    console.error('Slash command registration failed:', error);
  }
});

client.on('messageCreate', async message => {
  if (message.author.bot) return;
  if (message.guild) return;

  try {
    await forwardCustomerMessage(message);
  } catch (error) {
    console.error('DM ticket handling failed:', error);
    await message.author.send(
      'Hashwear Support could not open your ticket right now. Please try again in a moment.'
    ).catch(() => {});
  }
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (!isSupport(interaction)) {
    return interaction.reply({ content: 'This command is only available to Hashwear support staff.', ephemeral: true });
  }

  try {
    if (interaction.commandName === 'areply') return sendStaffReply(interaction, false);
    if (interaction.commandName === 'reply') return sendStaffReply(interaction, true);
    if (interaction.commandName === 'close') return handleClose(interaction);
    if (interaction.commandName === 'notify') return handleNotify(interaction);

    if (interaction.commandName === 'ticket-info') {
      const ctx = await getTicketContext(interaction);
      if (ctx.error) return interaction.reply({ content: ctx.error, ephemeral: true });
      const ticket = getTicket(ctx.ticket.userId);
      const users = (ticket.notifyUserIds || []).map(id => `<@${id}>`).join(', ') || 'None';
      const roles = (ticket.notifyRoleIds || []).map(id => `<@&${id}>`).join(', ') || 'None';
      return interaction.reply({
        content:
          `**Customer:** <@${ticket.userId}> (${ticket.userTag})\n` +
          `**User ID:** \`${ticket.userId}\`\n` +
          `**Opened:** <t:${Math.floor(new Date(ticket.openedAt).getTime() / 1000)}:R>\n` +
          `**Notify users:** ${users}\n` +
          `**Notify roles:** ${roles}`,
        ephemeral: true,
        allowedMentions: { parse: [] },
      });
    }
  } catch (error) {
    console.error('Interaction failed:', error);
    const payload = { content: 'Something went wrong while running that command.', ephemeral: true };
    if (interaction.replied || interaction.deferred) return interaction.followUp(payload).catch(() => {});
    return interaction.reply(payload).catch(() => {});
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
