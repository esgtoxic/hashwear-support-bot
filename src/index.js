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

// Discord's GIF picker sends the selected GIF as a separate message.
// When a staff member sends .areply or .reply with nothing after it,
// the next message from that staff member in that ticket is treated as the reply.
const pendingReplies = new Map();
const processingPendingMessages = new Set();
const PENDING_REPLY_TIMEOUT_MS = 60_000;

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
      { name: 'Notifications', value: '`.sub` — subscribe yourself, `.unsub` — unsubscribe yourself', inline: false },
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

function getPendingReplyKey(message) {
  return `${message.channelId}:${message.author.id}`;
}

function getGifMedia(message, replyText = '') {
  const textUrlMatch = String(replyText || '').match(
    /https?:\/\/(?:www\.)?(?:tenor\.com|giphy\.com|media\.tenor\.com|media\.giphy\.com)\/\S+/i
  );

  const gifEmbed = message.embeds.find(embed =>
    embed.type === 'gifv' ||
    embed.video?.url ||
    (embed.url && /tenor\.com|giphy\.com|media\.tenor\.com|media\.giphy\.com/i.test(embed.url))
  );

  const pageUrl =
    textUrlMatch?.[0] ||
    gifEmbed?.url ||
    null;

  const mediaUrl =
    gifEmbed?.video?.url ||
    gifEmbed?.image?.url ||
    gifEmbed?.thumbnail?.url ||
    null;

  if (!pageUrl && !mediaUrl) return null;

  return {
    pageUrl,
    mediaUrl,
    previewUrl: gifEmbed?.image?.url || gifEmbed?.thumbnail?.url || null,
  };
}

function getStickerMedia(message) {
  const sticker = message.stickers?.first?.();
  if (!sticker) return null;

  return {
    name: sticker.name || 'Sticker',
    url: sticker.url || null,
  };
}

function hasForwardableMedia(message) {
  return Boolean(
    message?.attachments?.size ||
    getGifMedia(message, message?.content || '') ||
    getStickerMedia(message)
  );
}

async function findPreviousMediaMessage(commandMessage) {
  const recent = await commandMessage.channel.messages.fetch({
    limit: 15,
    before: commandMessage.id,
  }).catch(() => null);

  if (!recent) return null;

  const candidates = [...recent.values()]
    .filter(msg => msg.author?.id === commandMessage.author.id)
    .sort((a, b) => b.createdTimestamp - a.createdTimestamp);

  for (const candidate of candidates) {
    // Only grab a recent media post from the same staff member.
    if (commandMessage.createdTimestamp - candidate.createdTimestamp > 120_000) break;
    if (candidate.content?.trim().startsWith('.')) continue;
    if (hasForwardableMedia(candidate)) return candidate;
  }

  return null;
}

async function sendTextReply(message, ticket, direct, replyText, options = {}) {
  const customer = await client.users.fetch(ticket.userId).catch(() => null);
  if (!customer) {
    await message.reply('I could not find the customer account.');
    return false;
  }

  const attachments = [...message.attachments.values()];
  const gifMedia = getGifMedia(message, replyText);
  const stickerMedia = getStickerMedia(message);

  // Discord media can arrive as an attachment, a gifv embed, or a sticker.
  if (!replyText && !attachments.length && !gifMedia && !stickerMedia) {
    return false;
  }

  const staffName = message.member?.displayName || message.author.globalName || message.author.username;
  const imageAttachment = attachments.find(file => file.contentType?.startsWith('image/'));

  let displayText = replyText || '';
  if (gifMedia?.pageUrl && displayText) {
    displayText = displayText.replace(gifMedia.pageUrl, '').trim();
  }

  const replyEmbed = new EmbedBuilder()
    .setAuthor({
      name: direct ? `${staffName} • Support` : 'Hashwear Support',
      iconURL: direct ? message.author.displayAvatarURL() : client.user.displayAvatarURL(),
    })
    .setDescription(displayText || (gifMedia ? '*GIF*' : stickerMedia ? `*${stickerMedia.name}*` : '*Attachment*'))
    .setTimestamp();

  if (imageAttachment) {
    replyEmbed.setImage(imageAttachment.url);
  } else if (gifMedia?.previewUrl) {
    replyEmbed.setImage(gifMedia.previewUrl);
  } else if (stickerMedia?.url) {
    replyEmbed.setImage(stickerMedia.url);
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

  const files = attachments.map(file => file.url);

  const dmPayload = {
    embeds: [replyEmbed],
    files,
  };

  // Discord's GIF picker is most reliable when the original Tenor/Giphy URL
  // is sent as normal message content. Discord then renders the animated preview.
  if (gifMedia?.pageUrl) {
    dmPayload.content = gifMedia.pageUrl;
  } else if (stickerMedia?.url) {
    dmPayload.content = stickerMedia.url;
  }

  try {
    await customer.send(dmPayload);
  } catch (error) {
    console.error('Customer DM failed:', error);
    await message.reply('I could not DM the customer. They may have DMs disabled or blocked the bot.');
    return false;
  }

  const ticketReplyEmbed = new EmbedBuilder()
    .setAuthor({
      name: direct ? `${staffName} • Direct Reply` : `${staffName} • Anonymous Reply`,
      iconURL: message.author.displayAvatarURL(),
    })
    .setDescription(displayText || (gifMedia ? '*GIF*' : stickerMedia ? `*${stickerMedia.name}*` : '*Attachment*'))
    .setTimestamp();

  if (imageAttachment) {
    ticketReplyEmbed.setImage(imageAttachment.url);
  } else if (gifMedia?.previewUrl) {
    ticketReplyEmbed.setImage(gifMedia.previewUrl);
  } else if (stickerMedia?.url) {
    ticketReplyEmbed.setImage(stickerMedia.url);
  }

  if (nonImageAttachments.length) {
    ticketReplyEmbed.addFields({
      name: 'Attachments',
      value: nonImageAttachments
        .map(file => `[${file.name || 'file'}](${file.url})`)
        .join('\n')
        .slice(0, 1000),
    });
  }

  await message.channel.send({
    content: gifMedia?.pageUrl || stickerMedia?.url || undefined,
    embeds: [ticketReplyEmbed],
    files: attachments.map(file => file.url),
  });

  if (options.deleteSource) {
    await message.delete().catch(() => {});
  }

  return true;
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

async function subscribeToTicket(message, ticket) {
  const current = getTicket(ticket.userId);
  const alreadySubscribed = (current.notifyUserIds || []).includes(message.author.id);

  if (alreadySubscribed) {
    await message.reply({
      content: `${message.author} is already subscribed to notifications for this ticket.`,
      allowedMentions: { users: [message.author.id] },
    });
    return;
  }

  mutateNotifications(ticket.userId, currentTicket => {
    const set = new Set(currentTicket.notifyUserIds || []);
    set.add(message.author.id);
    currentTicket.notifyUserIds = [...set];
  });

  await message.reply({
    content: `${message.author} will now be notified whenever this customer sends a message.`,
    allowedMentions: { users: [message.author.id] },
  });
}

async function unsubscribeFromTicket(message, ticket) {
  const current = getTicket(ticket.userId);
  const isSubscribed = (current.notifyUserIds || []).includes(message.author.id);

  if (!isSubscribed) {
    await message.reply({
      content: `${message.author} is not subscribed to notifications for this ticket.`,
      allowedMentions: { users: [message.author.id] },
    });
    return;
  }

  mutateNotifications(ticket.userId, currentTicket => {
    const set = new Set(currentTicket.notifyUserIds || []);
    set.delete(message.author.id);
    currentTicket.notifyUserIds = [...set];
  });

  await message.reply({
    content: `${message.author} will no longer be notified for this ticket.`,
    allowedMentions: { users: [message.author.id] },
  });
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

async function tryHandlePendingReply(message, options = {}) {
  if (!message || message.author?.bot || !message.guild) return false;
  if (message.guild.id !== GUILD_ID) return false;

  const pendingKey = getPendingReplyKey(message);
  const pending = pendingReplies.get(pendingKey);
  if (!pending) return false;

  if (pending.expiresAt <= Date.now()) {
    pendingReplies.delete(pendingKey);
    return false;
  }

  const trimmedContent = message.content?.trim() || '';
  const isDotCommand = trimmedContent.startsWith('.');
  const isOriginalReplyCommand =
    pending.commandMessageId === message.id &&
    /^\.(?:areply|reply)$/i.test(trimmedContent);

  if (isDotCommand && !isOriginalReplyCommand) return false;

  const processingKey = `${pendingKey}:${message.id}`;
  if (processingPendingMessages.has(processingKey)) return false;
  processingPendingMessages.add(processingKey);

  try {
    // GIF-picker embeds are sometimes attached after MESSAGE_CREATE.
    // Give Discord a moment, then refetch the message so gifv/video data is present.
    if (!options.skipDelay) {
      await new Promise(resolve => setTimeout(resolve, 1400));
    }

    const refreshed = await message.channel.messages.fetch(message.id).catch(() => message);
    const ticket = getTicketByChannel(refreshed.channelId);

    if (!ticket || ticket.status !== 'open' || !isSupportMember(refreshed.member)) {
      return false;
    }

    const refreshedContent = refreshed.content?.trim() || '';
    const text =
      pending.commandMessageId === refreshed.id &&
      /^\.(?:areply|reply)$/i.test(refreshedContent)
        ? ''
        : refreshedContent;

    const sent = await sendTextReply(
      refreshed,
      ticket,
      pending.direct,
      text,
      { deleteSource: true }
    );

    if (sent) {
      pendingReplies.delete(pendingKey);
      return true;
    }

    return false;
  } finally {
    processingPendingMessages.delete(processingKey);
  }
}

async function handleTicketTextCommand(message) {
  const ticket = getTicketByChannel(message.channelId);
  if (!ticket || ticket.status !== 'open') return false;

  const content = message.content.trim();
  const match = content.match(/^\.(areply|reply|close|sub|unsub|ticketinfo)(?:\s+([\s\S]*))?$/i);
  if (!match) return false;

  if (!isSupportMember(message.member)) {
    await message.reply('This command is only available to Hashwear support staff.');
    return true;
  }

  const command = match[1].toLowerCase();
  const text = (match[2] || '').trim();

  if (command === 'areply' || command === 'reply') {
    const direct = command === 'reply';

    let replyMessage = message;
    if (!text && !message.attachments.size && !getGifMedia(message, text) && !getStickerMedia(message)) {
      await new Promise(resolve => setTimeout(resolve, 700));
      replyMessage = await message.channel.messages.fetch(message.id).catch(() => message);
    }

    let sent = await sendTextReply(replyMessage, ticket, direct, text);

    // Discord's GIF picker normally sends the GIF first as its own message.
    // If .areply/.reply is sent immediately afterwards, use that previous media message.
    if (!sent && !text) {
      const previousMedia = await findPreviousMediaMessage(message);
      if (previousMedia) {
        sent = await sendTextReply(
          previousMedia,
          ticket,
          direct,
          '',
          { deleteSource: true }
        );

        if (sent) {
          await message.delete().catch(() => {});
          return true;
        }
      }
    }

    if (!sent) {
      const key = getPendingReplyKey(message);
      pendingReplies.set(key, {
        direct,
        commandMessageId: message.id,
        expiresAt: Date.now() + PENDING_REPLY_TIMEOUT_MS,
      });

      setTimeout(() => {
        const pending = pendingReplies.get(key);
        if (pending && pending.expiresAt <= Date.now()) {
          pendingReplies.delete(key);
        }
      }, PENDING_REPLY_TIMEOUT_MS + 1000);
    }

    return true;
  }

  if (command === 'close') {
    await closeTextTicket(message, ticket, text);
    return true;
  }

  if (command === 'sub') {
    await subscribeToTicket(message, ticket);
    return true;
  }

  if (command === 'unsub') {
    await unsubscribeFromTicket(message, ticket);
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
    const handledPending = await tryHandlePendingReply(message);
    if (handledPending) return;

    await handleTicketTextCommand(message);
  } catch (error) {
    console.error('Ticket text command failed:', error);
    await message.reply('Something went wrong while running that command.').catch(() => {});
  }
});

client.on('messageUpdate', async (oldMessage, newMessage) => {
  try {
    if (newMessage.partial) {
      newMessage = await newMessage.fetch().catch(() => newMessage);
    }

    if (!newMessage.guild || newMessage.guild.id !== GUILD_ID) return;
    if (newMessage.author?.bot) return;

    // This catches GIF/video embed data that Discord adds after MESSAGE_CREATE.
    await tryHandlePendingReply(newMessage, { skipDelay: true });
  } catch (error) {
    console.error('Pending GIF messageUpdate handling failed:', error);
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
