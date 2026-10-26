import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point config loading at a temp HOME before importing src modules.
const home = mkdtempSync(join(tmpdir(), "skool-mcp-test-"));
process.env.HOME = home;
mkdirSync(join(home, ".config", "skool-mcp"), { recursive: true });
writeFileSync(
  join(home, ".config", "skool-mcp", "config.json"),
  JSON.stringify({ cookies: "auth_token=test-only", defaultCommunity: "", baseUrl: "https://www.skool.com" }),
);

type Call = { url: string; method: string; body: unknown; headers: Record<string, string> };
let calls: Call[] = [];
let posts: typeof import("../src/tools/posts.ts");
let videos: typeof import("../src/tools/videos.ts");

const realFetch = globalThis.fetch;

before(async () => {
  posts = await import("../src/tools/posts.ts");
  videos = await import("../src/tools/videos.ts");
});

function mockFetch(responder: (call: Call) => Response) {
  calls = [];
  globalThis.fetch = (async (url: unknown, opts: Record<string, unknown> = {}) => {
    const body =
      typeof opts.body === "string" ? JSON.parse(opts.body) : opts.body;
    const call: Call = {
      url: String(url),
      method: String(opts.method ?? "GET"),
      body,
      headers: (opts.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    return responder(call);
  }) as typeof fetch;
}

function jsonOk(obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test.afterEach(() => {
  globalThis.fetch = realFetch;
});

const GROUP = "group-00000000000000000000000001";
const POST = "post-000000000000000000000000001";

test("comment posts to /posts with post_type comment and parent/root ids", async () => {
  mockFetch(() => jsonOk({ id: "comment-1" }));
  const out = await posts.postsCommentTool.handler({ postId: POST, groupId: GROUP, content: "hello" });
  assert.equal(JSON.parse(out).id, "comment-1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api2.skool.com/posts?notify=false&follow=true");
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(calls[0].body, {
    post_type: "comment",
    group_id: GROUP,
    parent_id: POST,
    root_id: POST,
    metadata: { action: 0, content: "hello", video_ids: "" },
  });
});

test("create post carries uploaded video ids and an external video link", async () => {
  mockFetch(() => jsonOk({ id: "post-1" }));
  await posts.postsCreateTool.handler({
    groupId: GROUP,
    title: "Title",
    content: "Body",
    videoIds: ["video-1", "video-2"],
    videoLink: "https://www.youtube.com/watch?v=abc123",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api2.skool.com/posts?notify=false&follow=true");
  assert.deepEqual(calls[0].body, {
    post_type: "generic",
    group_id: GROUP,
    metadata: {
      action: 0,
      content: "Body",
      video_ids: "video-1,video-2",
      title: "Title",
      video_links: "https://www.youtube.com/watch?v=abc123",
    },
  });
});

test("create post joins multiple video links with newlines", () => {
  const payload = posts.buildCreatePayload({
    groupId: GROUP,
    title: "T",
    content: "C",
    videoLinks: ["https://vimeo.com/123", "https://www.loom.com/share/abc"],
  });
  const meta = payload.metadata as Record<string, unknown>;
  assert.equal(meta.video_links, "https://vimeo.com/123\nhttps://www.loom.com/share/abc");
  assert.equal(meta.video_ids, "");
});

test("unsupported or malformed video links are rejected before any HTTP call", async () => {
  mockFetch(() => jsonOk({}));
  await assert.rejects(
    () => posts.postsCreateTool.handler({ groupId: GROUP, title: "T", content: "C", videoLink: "https://example.com/video" }),
    /Unsupported video link.*YouTube, Vimeo, Loom, and Wistia/,
  );
  await assert.rejects(
    () => posts.postsCreateTool.handler({ groupId: GROUP, title: "T", content: "C", videoLink: "not a url" }),
    /Invalid video link/,
  );
  assert.equal(calls.length, 0);
});

test("more than 10 videos are rejected before any HTTP call", async () => {
  mockFetch(() => jsonOk({}));
  await assert.rejects(
    () =>
      posts.postsCreateTool.handler({
        groupId: GROUP,
        title: "T",
        content: "C",
        videoIds: Array.from({ length: 11 }, (_, i) => `video-${i}`),
      }),
    /at most 10 videos/,
  );
  assert.equal(calls.length, 0);
});

test("upload video creates a Mux video then PUTs the bytes to the upload URL", async () => {
  const file = join(home, "clip.mp4");
  writeFileSync(file, Buffer.from([0, 1, 2, 3]));
  mockFetch((call) => {
    if (call.url === "https://api2.skool.com/videos") {
      return jsonOk({ videoId: "video-1", uploadUrl: "https://upload.example.test/put-here" });
    }
    return new Response("", { status: 200 });
  });

  const out = await videos.postsUploadVideoTool.handler({
    groupId: GROUP,
    filePath: file,
    referenceType: "post",
  });
  assert.equal(JSON.parse(out).videoId, "video-1");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].body, {
    group_id: GROUP,
    file_name: "clip.mp4",
    content_type: "video/mp4",
    content_length: 4,
    reference_type: "post",
  });
  assert.equal(calls[1].url, "https://upload.example.test/put-here");
  assert.equal(calls[1].method, "PUT");
  assert.equal((calls[1].body as Uint8Array).length, 4);
  // Signed upload URL must not receive the session cookie.
  assert.equal(calls[1].headers.Cookie, undefined);
});

test("upload rejects non-video files and empty files before any HTTP call", async () => {
  mockFetch(() => jsonOk({}));
  const txt = join(home, "notes.txt");
  writeFileSync(txt, "hello");
  await assert.rejects(
    () => videos.postsUploadVideoTool.handler({ groupId: GROUP, filePath: txt, referenceType: "post" }),
    /Cannot determine video content type/,
  );
  const empty = join(home, "empty.mp4");
  writeFileSync(empty, "");
  await assert.rejects(
    () => videos.postsUploadVideoTool.handler({ groupId: GROUP, filePath: empty, referenceType: "post" }),
    /Video file is empty/,
  );
  await assert.rejects(
    () => videos.postsUploadVideoTool.handler({ groupId: GROUP, filePath: join(home, "missing.mp4"), referenceType: "post" }),
    /Video file not found/,
  );
  assert.equal(calls.length, 0);
});

test("video size limit is under 30GB with a clear error", () => {
  assert.throws(() => videos.assertVideoSize(videos.MAX_VIDEO_BYTES), /too large.*under 30GB/);
  assert.throws(() => videos.assertVideoSize(videos.MAX_VIDEO_BYTES + 1), /too large/);
  assert.doesNotThrow(() => videos.assertVideoSize(videos.MAX_VIDEO_BYTES - 1));
});
