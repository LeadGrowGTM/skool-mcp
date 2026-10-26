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
- `skool.posts.create` — Create a new post. Attach files with `attachmentIds`, an uploaded video with `videoIds`, or an external video with `videoLink`/`videoLinks` (YouTube, Vimeo, Loom, or Wistia; at most 10 videos total)
- `skool.posts.comment` — Comment on a post (also accepts `videoIds`/`videoLink`/`videoLinks`)
- `skool_posts_upload_video` — Upload a local video file (under 30GB) and return its video id for `videoIds`

#### Posting a video

Uploaded video (creates an upload on Skool, so only run it when you intend to post):

```text
skool_posts_upload_video { groupId, filePath: "/path/clip.mp4" }  -> { videoId, ... }
skool_posts_create { groupId, title, content, videoIds: ["<videoId>"] }
```

External video (no upload): pass `videoLink: "https://www.youtube.com/watch?v=..."` (or a Vimeo, Loom, or Wistia URL) to `skool_posts_create` or `skool_posts_comment`. Unsupported hosts are rejected before any request.

Comments are created with `POST /posts` using `post_type: "comment"` and `parent_id`/`root_id` set to the parent post id. The former `POST /comments` route returns 404.

### Classroom
- `skool.courses.list` — List courses
- `skool.lessons.list` — List lessons in a course

### Notifications
- `skool_notifications` — Read notifications without marking them read. Use `cursor` from the previous response's `next_cursor` instead of the former `page` argument; optionally filter with `categories` and `unread_only`. See [notification details](docs/state/notifications-fallback.md).

### Chat (read-only)
- `skool_chat_channels` — List DM channels with unread counts and last-message text. Supports `offset` (default 0), `limit` (default 20, maximum 30), and `unread_only`. Set `include_last_message=false` to skip message lookups. Filtering applies to the fetched page; continue using `next_offset` even if the filtered page is empty. A failed last-message request fails the call.
- `skool_chat_messages` — Read a `channel_id` with `limit` (default 20, maximum 50). Returns messages oldest first, defaulting to the latest messages. To fetch older messages, pass the returned `oldest_message_id` as `before_message_id`; `has_more_before` indicates whether more are available.

Both chat tools use GET requests and never send messages, react, or mark messages read.

### Billing (read-only)
- `skool_payouts` — Read balances, payout account status, and transfer history for a group you own. Supports `offset` (default 0) and `limit` (default 50, maximum 100); `has_more` indicates more transfer history. Amounts are converted from cents to currency units. Bank account details are omitted.
- `skool_revenue` — Read membership prices and counts, plus estimated gross monthly recurring revenue (`mrr_gross`) before fees. Annual prices are divided by 12, monthly prices are used directly, and other intervals contribute zero to MRR.

Both require an explicit `groupId`; `defaultCommunity` is not used. They only make GET requests and never trigger payouts or change billing settings.

### Read-only CLI

After building, use the same authentication configuration with:

```bash
node scripts/skool-read.mjs payouts '{"groupId":"YOUR_GROUP_ID"}'
node scripts/skool-read.mjs revenue '{"groupId":"YOUR_GROUP_ID"}'
```

The CLI also accepts `notifications`, `channels`, and `messages`. Pass tool arguments as a JSON object; the tool schema validates them and applies defaults before the handler runs. Arguments default to `{}` when omitted, so required fields must still be supplied. Results are printed to stdout.

## Tests

```bash
npm test   # mocked-HTTP unit tests for comment/video payloads; no live Skool calls
```

## API Notes

- **Community read operations** generally use Next.js data routes (`/_next/data/{buildId}/...`). The `buildId` is fetched dynamically.
- **Write operations**, notifications, chat, and billing use `api2.skool.com` REST endpoints.
- A `User-Agent` header is required (CloudFront blocks bare requests with 403).
- See `API-DISCOVERY.md` for detailed endpoint documentation and response shapes.
