const fs = require('node:fs');
const path = require('node:path');

const DATA_FILE = process.env.DATA_FILE || path.join(process.cwd(), 'data', 'tickets.json');

function ensureStore() {
  const dir = path.dirname(DATA_FILE);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ tickets: {} }, null, 2));
  }
}

function readStore() {
  ensureStore();
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!parsed.tickets || typeof parsed.tickets !== 'object') parsed.tickets = {};
    return parsed;
  } catch (error) {
    console.error('Store read failed, recreating store:', error);
    const fresh = { tickets: {} };
    fs.writeFileSync(DATA_FILE, JSON.stringify(fresh, null, 2));
    return fresh;
  }
}

function writeStore(data) {
  ensureStore();
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

function getTicket(userId) {
  return readStore().tickets[userId] || null;
}

function getTicketByChannel(channelId) {
  const tickets = readStore().tickets;
  for (const [userId, ticket] of Object.entries(tickets)) {
    if (ticket.channelId === channelId && ticket.status === 'open') {
      return { userId, ...ticket };
    }
  }
  return null;
}

function upsertTicket(userId, ticket) {
  const data = readStore();
  data.tickets[userId] = {
    ...(data.tickets[userId] || {}),
    ...ticket,
  };
  writeStore(data);
  return data.tickets[userId];
}

function closeTicket(userId, closedBy, reason) {
  const data = readStore();
  if (!data.tickets[userId]) return null;
  data.tickets[userId] = {
    ...data.tickets[userId],
    status: 'closed',
    closedAt: new Date().toISOString(),
    closedBy,
    closeReason: reason || null,
  };
  writeStore(data);
  return data.tickets[userId];
}

function mutateNotifications(userId, mutator) {
  const data = readStore();
  const ticket = data.tickets[userId];
  if (!ticket) return null;

  ticket.notifyUserIds = Array.isArray(ticket.notifyUserIds) ? ticket.notifyUserIds : [];
  ticket.notifyRoleIds = Array.isArray(ticket.notifyRoleIds) ? ticket.notifyRoleIds : [];

  mutator(ticket);
  data.tickets[userId] = ticket;
  writeStore(data);
  return ticket;
}

module.exports = {
  DATA_FILE,
  getTicket,
  getTicketByChannel,
  upsertTicket,
  closeTicket,
  mutateNotifications,
};
