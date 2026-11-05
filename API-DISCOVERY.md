# Skool API Discovery Notes

## Architecture
- Skool is a **Next.js** app with SSR
- Real API backend: `https://api2.skool.com`
- PubSub WebSocket: `wss://groups-ps.skool.com/ws`
- Build IDs rotate (current: `1771547195804`) — must be fetched dynamically

## Next.js Data Routes (READ operations)
These work for public communities WITHOUT auth cookies:

```
GET https://www.skool.com/_next/data/{buildId}/{slug}.json?group={slug}
GET https://www.skool.com/_next/data/{buildId}/{slug}/classroom.json?group={slug}
GET https://www.skool.com/_next/data/{buildId}/{slug}/-/members.json?group={slug}
GET https://www.skool.com/_next/data/{buildId}/{slug}/-/leaderboards.json?group={slug}
GET https://www.skool.com/_next/data/{buildId}/{slug}/about.json?group={slug}
```

**IMPORTANT**: Must include `User-Agent` header (CloudFront blocks bare requests with 403).

### Getting Build ID
Parse from any Skool page HTML: `<script id="__NEXT_DATA__">` → `buildId` field.
Or: fetch the main page, extract `buildId` from the `_next/data` references in script tags.

### Community Feed Response Shape
```json
{
  "pageProps": {
    "category": "",
    "sortType": "newest-cm",
    "page": 1,
    "total": 10,
    "postTrees": [
      {
        "post": {
          "id": "uuid",
          "name": "slug",
          "metadata": {
            "action": 0,
            "comments": 1,
            "content": "post body text...",
            "displayName": "Post Title",
            "label": "category-uuid",
            "likes": 3,
            "media": "...",
            "pinned": 0
          },
          "createdAt": "ISO date",
          "updatedAt": "ISO date",
          "userId": "uuid",
          "groupId": "uuid"
        },
        "user": {
          "id": "uuid",
          "firstName": "Name",
          "lastName": "Last",
          "metadata": {
            "pictureBubble": "url",
            "spData": "{\"pts\":0,\"lv\":1,...}"
          }
        },
        "comments": [...]
      }
    ],
    "currentGroup": { ... },
    "self": { ... },
    "env": {
      "API_URL": "https://api2.skool.com",
      "PUBSUB_URL": "wss://groups-ps.skool.com/ws"
    }
  }
}
```

### Members Response Shape
```json
{
  "pageProps": {
    "tabName": "active",
    "users": [
      {
        "id": "uuid",
        "name": "username-slug",
        "metadata": {
          "bio": "text",
          "online": 1,
          "pictureBubble": "url",
          "pictureProfile": "url",
          "spData": "{\"pts\":0,\"lv\":1,\"pcl\":0,\"pnl\":5,\"role\":4}"
        },
        "firstName": "Kit",
        "lastName": "Fox",
        "member": {
          "id": "uuid",
          "role": "member",
          "approvedAt": "ISO date",
          "metadata": {
            "approvedBy": "uuid",
            "requestLocation": "chicago (united states)"
          }
        }
      }
    ],
    "page": 1,
    "totalPages": 1,
    "itemsPerPage": 30,
    "totalMembers": 3,
    "totalAdmins": 1,
    "totalOnlineMembers": 2
  }
}
```

### Classroom Response Shape
```json
{
  "pageProps": {
    "allCourses": [...],
    "course": null,
    "selectedModule": "uuid"
  }
}
```

## Authentication
- Auth cookies are **httpOnly** — not visible to JavaScript `document.cookie`
- Need to extract from browser cookie jar or use CDP to get all cookies
- For authenticated routes (pending members, creating posts, approving), cookies must be included

## Key IDs (AI Agent Academy)
- Group ID: `43d26b9b5d12421d9578cc50019b2c9e`
- My user ID: `a878b211d3e54c8184d20eac9351306b`
- Group slug: `ai-agent-academy-6994`

## Categories (Labels)
- General discussion: `24911c0cdbd742a896b036dedd4fa804`
- Lessons & Tutorials: `63cd239466e94e41bce37e3dd518a987`
- Ask Louie: `52c41a0a9c8a4c5284423c98352f59e9`
- Show & Tell: `4ba236571d7e4e9f9808084136f07646`
- Agent Economy: `f9c9ce4100ad422b8f72795ba7fb2114`

## api2.skool.com REST API (confirmed working)

Auth: `Cookie: auth_token={jwt}` header. JWT is httpOnly, stored in browser.

### Confirmed endpoints:
- `GET /health` → 200
- `GET /groups/{groupId}` → full group details (snake_case metadata)
- `GET /groups/{groupId}/courses` → `{"courses": [...]}`
- `GET /groups/{groupId}/labels` → `{"labels": [...]}`
- `POST /posts` → Create post (needs proper metadata, returns "invalid metadata" with wrong body)
- `GET /posts` → 405 (POST only, used for creating)
- `GET /users` → 405 (POST only)
- `GET /groups` → 405 (POST only)

### api2 uses snake_case (unlike Next.js camelCase)!

### Post creation (needs more research):
```
POST https://api2.skool.com/posts
Cookie: auth_token=...
Content-Type: application/json

{"groupId": "...", "metadata": {"content": "...", "displayName": "Title", "label": "category-id", ...}}
```
Returns "invalid metadata" — needs correct field set. Look at network tab when creating a post in browser.

### Not found on api2:
- `/groups/{id}/posts` — 404
- `/groups/{id}/members` — 404
- `/groups/{id}/pending` — 404
- `/members` — 404

### Auth token (JWT):
- Stored as `auth_token` httpOnly cookie on `.skool.com`
- Current token expires 2027 (long-lived!)
- Config location: `~/.config/skool-mcp/config.json`


### Classroom video upload

`skool_upload_video` accepts `groupId` and exactly one of `filePath` or
`sourceUrl` (HTTP(S)), plus optional `fileName`, `contentType`, `referenceType`
(`post` by default, `comment`, or `module`) and `lessonId` (32 hex characters).
`skool_posts_upload_video` remains a compatible wrapper. Supported extensions:
mp4, m4v, mov, webm, avi, mkv; files must be non-empty and strictly under
32212254720 bytes (30 GiB). Local validation precedes HTTP; remote size is
validated during download before any Skool API call. Remote downloads send no
Skool cookies and spool to a temporary file, including when Content-Length is
missing. Temporary files are removed on success and failure.

The tool POSTs `/videos`, then PUTs bytes to the returned upload URL without
cookies. Files up to 8 MiB use one PUT; larger files use sequential 8 MiB chunks
with Content-Range and up to three retries per failed chunk. Intermediate chunks
must return 308; the final chunk must return 2xx. This resumable protocol is
mock-tested only; no live upload was performed, and restart across tool calls is
not supported. Returns `videoId`, `fileName`, `contentType`, `contentLength`,
`referenceType`, `uploaded: true`, and `lessonAttached: true` after attachment.
Processing may still be underway.

`lessonId` implies `referenceType: module` and attaches after upload.
**The `module` reference value is unproven for lessons.**
`skool_lessons_set_video { lessonId, videoId, videoLink? }` also attaches an
existing video: GET `/courses/{lessonId}`, then PUT the merged full lesson to
that same endpoint with `video_id` (and optional `video_link`). It preserves all
read fields, including title, desc, resources, transcript, privacy, min_tier and
state, and refuses the write if any required preservation field is absent.
Partial PUTs can reset privacy to Open; never send one. These lesson writes are
covered with mocked fetch only, not live API verification.
