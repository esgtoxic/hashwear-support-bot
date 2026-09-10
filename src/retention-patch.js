const fs = require('node:fs');
const path = require('node:path');
const {
  REST,
  Routes,
  TextChannel,
} = require('discord.js');

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const DATA_FILE = process.env.DATA_FILE || path.join(process.cwd(), 'data', 'tickets.json');
const RETENTION_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 1000;
const STATE_FILE = path.join(path.dirname(DATA_FILE), 'retention-state.json');

const originalSetTimeout = global.setTimeout;

// The main bot currently schedules channel deletion 1.5 seconds after .close.
// Replace only that specific close-ticket timer with a 24-hour timer.
global.setTimeout = function patchedSetTimeout(callback, delay, ...args) {
  if (
    delay === 1500 &&
    typeof callback === 'function' &&
    /message\.channel\.delete/.test(Function.prototype.toString.call(callback))
  ) {
    return originalSetTimeout(callback, RETENTION_MS, ...args);
  }

  return originalSetTimeout(callback, delay, ...args);
};

// Update the staff-facing close confirmation so it matches the new retention behavior.
if (TextChannel?.prototype?.send) {
  const originalSend = TextChannel.prototype.send;

  TextChannel.prototype.send = function patchedSend(options) {
    if (typeof options === 'string' && options.includes('This channel will now be deleted.')) {
      options = options.replace(
        'This channel will now be deleted.',
        'This channel will remain available for 24 hours and will then be automatically deleted.'
      );
    }

    return originalSend.call(this, options);
  };
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(value, null, 2));
    fs.renameSync(temp, file);
  } catch (error) {
    console.error('Retention state write failed:', error);
  }
}

function readRetentionState() {
  const state = readJson(STATE_FILE, { deletedChannelIds: [] });
  if (!Array.isArray(state.deletedChannelIds)) state.deletedChannelIds = [];
  return state;
}

function markDeleted(channelId) {
  const state = readRetentionState();
  const ids = new Set(state.deletedChannelIds);
  ids.add(channelId);
  state.deletedChannelIds = [...ids].slice(-5000);
  writeJson(STATE_FILE, state);
}

async function cleanupExpiredClosedTickets() {
  if (!TOKEN) return;

  const data = readJson(DATA_FILE, null);
  if (!data?.tickets || typeof data.tickets !== 'object') return;

  const state = readRetentionState();
  const alreadyDeleted = new Set(state.deletedChannelIds);
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  const now = Date.now();

  for (const ticket of Object.values(data.tickets)) {
    if (!ticket || ticket.status !== 'closed') continue;
    if (!ticket.channelId || !ticket.closedAt) continue;
    if (alreadyDeleted.has(ticket.channelId)) continue;

    const closedAt = new Date(ticket.closedAt).getTime();
    if (!Number.isFinite(closedAt)) continue;
    if (now - closedAt < RETENTION_MS) continue;

    try {
      await rest.delete(Routes.channel(ticket.channelId), {
        reason: 'Hashwear Support ticket 24-hour retention expired',
      });
      markDeleted(ticket.channelId);
      console.log(`Deleted closed support ticket channel ${ticket.channelId} after 24-hour retention.`);
    } catch (error) {
      // Unknown Channel means it was already deleted (for example by the in-memory 24h timer).
      if (error?.status === 404 || error?.code === 10003) {
        markDeleted(ticket.channelId);
        continue;
      }

      console.error(`Could not delete expired support ticket channel ${ticket.channelId}:`, error);
    }
  }
}

// Run shortly after startup, then once per minute. This makes retention survive Render restarts.
originalSetTimeout(() => {
  cleanupExpiredClosedTickets().catch(error => {
    console.error('Initial support ticket retention cleanup failed:', error);
  });
}, 10_000);

setInterval(() => {
  cleanupExpiredClosedTickets().catch(error => {
    console.error('Support ticket retention cleanup failed:', error);
  });
}, CLEANUP_INTERVAL_MS);
