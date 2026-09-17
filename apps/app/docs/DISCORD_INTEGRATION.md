# Discord Integration for Waitlist

This document explains how to set up Discord OAuth verification for the waitlist
feature. For the full closed-beta rollout (including `LAUNCH_STATUS` and smoke
tests), see [Launch Checklist](../../docs/launch-checklist.md).

## Overview

The Discord integration allows waitlist users to:

1. Join your Discord server via an invite link
2. Verify their Discord membership through OAuth
3. Automatically earn +2 points after verification

## WhatsApp Community Groups

The waitlist also supports a WhatsApp group for communities where Discord is not
a natural fit, such as restaurant and local-business startups. Set the optional
invite URL in the app environment:

```bash
WHATSAPP_GROUP_INVITE_URL="https://chat.whatsapp.com/your-group-invite"
```

The waitlist will show both a `Share on WhatsApp` referral action and a
`Join our WhatsApp group` action. WhatsApp does not provide a membership check
for this invite flow, so group participation is intentionally manual: an admin
can open **Admin → Waitlist**, choose **Add points**, and award the appropriate
amount after confirming that the person joined. Admin awards accept whole
numbers from 1 to 1,000 points.

## Setup Instructions

### 1. Create a Discord Application

1. Go to https://discord.com/developers/applications
2. Click "New Application" and give it a name
3. Navigate to the "OAuth2" section in the left sidebar

### 2. Configure OAuth2 Settings

1. In the OAuth2 section, add a redirect URL:
   - Development: `http://localhost:3001/auth/discord/verify`
   - Production: `https://yourdomain.com/auth/discord/verify`

2. Note your Client ID and Client Secret (you'll need these for environment
   variables)

### 3. Create a Bot (Optional but Recommended)

For webhook-based verification (future enhancement), you'll need a bot:

1. Navigate to the "Bot" section
2. Click "Add Bot"
3. Under "Token", click "Reset Token" to generate a bot token
4. Enable these Privileged Gateway Intents:
   - Server Members Intent (to verify guild membership)

5. Invite the bot to your server:
   - Go to OAuth2 → URL Generator
   - Select scopes: `bot`
   - Select bot permissions: `Read Messages/View Channels`
   - Use the generated URL to invite the bot to your server

### 4. Get Your Guild (Server) ID

1. Enable Developer Mode in Discord:
   - User Settings → Advanced → Developer Mode
2. Right-click your server icon and select "Copy ID"
3. This is your Guild ID

### 5. Configure Environment Variables

Add the following to your `.env` file:

```bash
# Discord Integration Configuration
DISCORD_INVITE_URL="https://discord.gg/your-server-invite-code"
DISCORD_CLIENT_ID="your-discord-client-id"
DISCORD_CLIENT_SECRET="your-discord-client-secret"
DISCORD_REDIRECT_URI="http://localhost:3001/auth/discord/verify"  # Update for production
DISCORD_BOT_TOKEN="your-discord-bot-token"  # Optional, for future webhook verification
DISCORD_GUILD_ID="your-discord-server-guild-id"
```

### 6. Restart Your Application

After setting the environment variables, restart your development server or
redeploy your application.

## How It Works

### User Flow

1. User lands on the waitlist page (`/waitlist`)
2. User clicks "Join Discord server" to join via the invite link
3. User clicks "Verify Discord membership" to start OAuth flow
4. User is redirected to Discord to authorize the application
5. Discord redirects back to `/auth/discord/verify` with an authorization code
6. The application:
   - Exchanges the code for an access token
   - Fetches the user's guild memberships
   - Verifies the user is in the configured Discord server
   - Awards +2 points if verification succeeds
7. User is redirected back to waitlist page with success/error message

### Technical Flow

```
┌─────────┐      ┌──────────────┐      ┌─────────┐      ┌──────────┐
│ Waitlist│─────▶│ Discord OAuth│─────▶│ Discord │─────▶│ Callback │
│  Page   │      │  Initiation  │      │   Auth  │      │  Handler │
└─────────┘      └──────────────┘      └─────────┘      └──────────┘
                                                               │
                                                               ▼
                                                        ┌──────────────┐
                                                        │ Verify Guild │
                                                        │  Membership  │
                                                        └──────────────┘
                                                               │
                                                               ▼
                                                        ┌──────────────┐
                                                        │Award Points &│
                                                        │   Redirect   │
                                                        └──────────────┘
```

## Fallback Behavior

If Discord OAuth is not configured:

- The invite link will still be shown (if `DISCORD_INVITE_URL` is set)
- The "Verify Discord membership" button will not appear
- A message will inform users that verification is manual
- Users need to contact support to claim points

## Security Considerations

1. **Client Secret**: Never expose your Discord client secret in client-side
   code
2. **State Parameter**: The OAuth flow uses the userId as state to prevent CSRF
   attacks
3. **Token Storage**: Access tokens are not persisted; they're only used during
   verification
4. **Guild Verification**: Points are only awarded if the user is actually in
   the Discord server

## Future Enhancements

### Webhook-Based Verification

For real-time verification without OAuth, you can implement Discord webhooks:

1. Set up a Discord bot with proper permissions
2. Listen for `GUILD_MEMBER_ADD` events
3. When a user joins, match their Discord user ID to your database
4. Automatically award points

This approach requires:

- Bot token (`DISCORD_BOT_TOKEN`)
- Guild ID (`DISCORD_GUILD_ID`)
- A webhook endpoint to receive Discord events
- A way to link Discord user IDs to your application users

### Enhanced Verification

- Store Discord user IDs in the database
- Allow users to disconnect and reconnect their Discord account
- Verify continued membership (revoke points if user leaves)
- Track additional Discord engagement (messages, reactions, etc.)

## Troubleshooting

### "Discord OAuth not configured" error

**Cause**: Missing required environment variables

**Solution**: Ensure all required variables are set:

- `DISCORD_CLIENT_ID`
- `DISCORD_CLIENT_SECRET`
- `DISCORD_REDIRECT_URI`
- `DISCORD_GUILD_ID`

### "Not in Discord Server" error

**Cause**: User hasn't joined the Discord server yet

**Solution**: Instruct users to click "Join Discord server" first, then verify

### OAuth redirect mismatch

**Cause**: `DISCORD_REDIRECT_URI` doesn't match what's configured in Discord
Developer Portal

**Solution**: Ensure the redirect URI in your environment variables exactly
matches what's in Discord Developer Portal (including protocol, domain, and
path)

### "Failed to exchange code for token"

**Cause**: Invalid client credentials or authorization code

**Solution**:

- Verify your `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET` are correct
- Authorization codes expire quickly; ensure the flow completes promptly

## Testing

To test the Discord integration:

1. Set up a test Discord server
2. Configure the environment variables with test credentials
3. Run through the complete flow:
   - Join the Discord server
   - Click verify on the waitlist page
   - Authorize the application
   - Verify points are awarded

## Resources

- [Discord OAuth2 Documentation](https://discord.com/developers/docs/topics/oauth2)
- [Discord API Reference](https://discord.com/developers/docs/intro)
- [Creating a Bot Application](https://discord.com/developers/docs/getting-started)
