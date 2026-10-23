# Skool MCP Server

An MCP (Model Context Protocol) server for interacting with Skool.com communities.

## Overview
Skool doesn't have a public API, so this MCP uses authenticated HTTP requests 
to Skool's internal API endpoints (reverse-engineered from the web app).

## Setup

### 1. Install & Build

```bash
cd /mnt/c/projects/skool-mcp   # or wherever you cloned it
npm install
npm run build
```

### 2. Configure Skool Auth

Create `~/.config/skool-mcp/config.json`:

```json
{
  "cookies": "your-skool-session-cookies-here",
  "defaultCommunity": "ai-agent-academy-6994",
  "baseUrl": "https://www.skool.com"
}
```

**Getting cookies:** Open Skool in Chrome → DevTools → Application → Cookies → copy the `auth_token` value. The `cookies` field should be: `auth_token=YOUR_JWT_HERE`

### 3. Configure Claude Code

Add to your `.mcp.json` (in your project root or `~/.claude/.mcp.json` for global):

```json
{
  "mcpServers": {
    "skool": {
      "command": "node",
      "args": ["/mnt/c/projects/skool-mcp/dist/index.js"],
      "env": {}
    }
  }
}
```

### 4. Configure mcporter (OpenClaw)

```bash
mcporter add skool --command "node /mnt/c/projects/skool-mcp/dist/index.js" --transport stdio
```

Then call tools via:
```bash
mcporter call skool "skool.request" method="GET" path="/api/v1/..."
```

## Authentication

Uses session cookies from an authenticated Skool session. The `auth_token` JWT is httpOnly and long-lived (expires ~1 year).

## Tools

### Discovery
- `skool.request` — Make arbitrary authenticated requests to Skool (for API exploration)

### Community
- `skool.community.info` — Get community details (name, description, member count, settings)

### Members
- `skool.members.list` — List members of a community
- `skool.members.pending` — List pending membership requests
- `skool.members.approve` — Approve a pending member
- `skool.members.reject` — Reject a pending member

### Posts
- `skool.posts.list` — List posts in a community (with category filter, pagination)
- `skool.posts.get` — Get a specific post with comments
- `skool.posts.create` — Create a new post
- `skool.posts.comment` — Comment on a post

### Classroom
- `skool.courses.list` — List courses
- `skool.lessons.list` — List lessons in a course

### Notifications
- `skool_notifications` — Read notifications without marking them read. Use `cursor` from the previous response's `next_cursor` instead of the former `page` argument; optionally filter with `categories` and `unread_only`. See [notification details](docs/state/notifications-fallback.md).

### Chat (read-only)
- `skool_chat_channels` — List DM channels with unread counts and last-message text. Supports `offset` (default 0), `limit` (default 20, maximum 30), and `unread_only`. Set `include_last_message=false` to skip message lookups. Filtering applies to the fetched page; continue using `next_offset` even if the filtered page is empty. A failed last-message request fails the call.
- `skool_chat_messages` — Read a `channel_id` with `limit` (default 20, maximum 50). Returns messages oldest first, defaulting to the latest messages. To fetch older messages, pass the returned `oldest_message_id` as `before_message_id`; `has_more_before` indicates whether more are available.

Both chat tools use GET requests and never send messages, react, or mark messages read.

## API Notes

- **Community read operations** generally use Next.js data routes (`/_next/data/{buildId}/...`). The `buildId` is fetched dynamically.
- **Write operations**, notifications, and chat use `api2.skool.com` REST endpoints.
- A `User-Agent` header is required (CloudFront blocks bare requests with 403).
- See `API-DISCOVERY.md` for detailed endpoint documentation and response shapes.
