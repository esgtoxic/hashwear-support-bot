const { SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('areply')
    .setDescription('Reply anonymously as Hashwear Support')
    .addStringOption(option =>
      option.setName('message').setDescription('Message to send to the customer').setRequired(false)
    )
    .addAttachmentOption(option =>
      option.setName('file').setDescription('Optional attachment').setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('reply')
    .setDescription('Reply to the customer with your staff name visible')
    .addStringOption(option =>
      option.setName('message').setDescription('Message to send to the customer').setRequired(false)
    )
    .addAttachmentOption(option =>
      option.setName('file').setDescription('Optional attachment').setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('close')
    .setDescription('Close this support ticket')
    .addStringOption(option =>
      option.setName('reason').setDescription('Reason for closing the ticket').setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('notify')
    .setDescription('Manage who is pinged when the customer sends a message')
    .addSubcommand(sub =>
      sub
        .setName('add-user')
        .setDescription('Ping a staff member on every customer message')
        .addUserOption(option => option.setName('user').setDescription('Staff member').setRequired(true))
    )
    .addSubcommand(sub =>
      sub
        .setName('remove-user')
        .setDescription('Stop pinging a staff member')
        .addUserOption(option => option.setName('user').setDescription('Staff member').setRequired(true))
    )
    .addSubcommand(sub =>
      sub
        .setName('add-role')
        .setDescription('Ping a role on every customer message')
        .addRoleOption(option => option.setName('role').setDescription('Role to ping').setRequired(true))
    )
    .addSubcommand(sub =>
      sub
        .setName('remove-role')
        .setDescription('Stop pinging a role')
        .addRoleOption(option => option.setName('role').setDescription('Role to stop pinging').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('list').setDescription('Show current ticket notification targets')
    ),

  new SlashCommandBuilder()
    .setName('ticket-info')
    .setDescription('Show the customer and notification settings for this ticket'),
];

module.exports = commands.map(command => command.toJSON());
