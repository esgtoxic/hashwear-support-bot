# Hashwear Support Bot

A Discord DM-to-ticket support bot for Hashwear.

## What it does

- Customers DM the bot instead of opening a public ticket.
- The first DM creates a private staff channel named `username`.
- Every later DM from that customer goes into the same open ticket.
- Customer screenshots/files are forwarded into the ticket.
- Staff can reply anonymously as **Hashwear Support** with `/areply`.
- Staff can reply with their staff display name visible using `/reply`.
- Staff can add/remove individual users or roles to be pinged whenever the customer sends a message.
- `/close` closes the ticket, DMs the customer, and deletes the staff channel.
- Ticket routing survives restarts using a persistent JSON data file.

## Commands

### `/areply`
Anonymous customer reply.

Options:
- `message` — optional text
- `file` — optional attachment

Customer sees:

> Hashwear Support: your message

### `/reply`
Named staff reply.

Customer sees:

> Reply from Staff Name: your message

### .sub — subscribe yourself to notifications for the current ticket
Pings that staff member whenever the customer sends a DM.

### `.sub remove-user user:@person`
Stops pinging that member.

### `.sub add-role role:@role`
Pings a role whenever the customer sends a DM.

### `.sub remove-role role:@role`
Stops pinging that role.

### `
Shows notification targets for the current ticket.

### `.ticketinfo`
Shows customer ID, ticket age, and notification targets.

### `/close reason:...`
Closes the ticket and deletes the ticket channel.

## Discord Developer Portal setup

1. Create or use a Discord application.
2. Set the application/bot name to **Hashwear Support**.
3. In **Bot**, enable **Message Content Intent**.
4. Reset/copy the bot token and store it only as `DISCORD_BOT_TOKEN` on your host. Never commit it to GitHub.
5. Invite the bot to the Hashwear server with both scopes:
   - `bot`
   - `applications.commands`
6. Give the bot permissions:
   - View Channels
   - Send Messages
   - Manage Channels
   - Read Message History
   - Embed Links
   - Attach Files

## Discord server setup

1. Create a private category such as `SUPPORT TICKETS`.
2. Copy its ID and use it for `SUPPORT_CATEGORY_ID`.
3. Copy the Hashwear server ID and use it for `DISCORD_GUILD_ID`.
4. Create/use one or more support staff roles and put their IDs in `SUPPORT_ROLE_IDS`, comma separated.
5. Put the bot role above any roles it needs to interact with in the server role list.

The customer does **not** need access to the ticket category. They communicate only through bot DMs.

## Environment variables

```env
DISCORD_BOT_TOKEN=...
DISCORD_GUILD_ID=...
SUPPORT_CATEGORY_ID=...
SUPPORT_ROLE_IDS=111111111111111111,222222222222222222
DATA_FILE=/var/data/tickets.json
PORT=10000
```

## Local run

```bash
npm install
npm start
```

The bot registers its guild slash commands automatically on startup.

## Render deployment

This repo contains a `render.yaml` Blueprint matching the same general always-on web-service style used for your other Discord bot.

1. Push this folder to a GitHub repo, for example `hashwear-support-bot`.
2. In Render, create a new Blueprint from the repo.
3. Add these secret environment values when prompted:
   - `DISCORD_BOT_TOKEN`
   - `DISCORD_GUILD_ID`
   - `SUPPORT_CATEGORY_ID`
   - `SUPPORT_ROLE_IDS`
4. Deploy.

The attached persistent disk stores ticket mappings at `/var/data/tickets.json` so restarts do not break open tickets.

## Recommended ticket flow

Customer DM -> `username` -> support team handles internally -> `/areply` or `/reply` -> customer gets DM -> `/close` when solved.
