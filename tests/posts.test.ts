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

function drainUploads(): Buffer[] {
  const sent: Buffer[] = [];
  const inner = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, opts: Record<string, unknown> = {}) => {
    if (opts.body instanceof ReadableStream) sent.push(Buffer.from(await new Response(opts.body).arrayBuffer()));
    return inner(url as string, opts);
  }) as typeof fetch;
  return sent;
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
  assert.equal(calls[0].url, "https://api2.skool.com/posts");
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
  let sent: Buffer = Buffer.alloc(0);
  mockFetch((call) => {
    if (call.url === "https://api2.skool.com/videos") {
      return jsonOk({ videoId: "video-1", uploadUrl: "https://upload.example.test/put-here" });
    }
    return new Response("", { status: 200 });
  });
  const inner = globalThis.fetch;
  // Drain the streamed body like real fetch does, before the handler closes the file.
  globalThis.fetch = (async (url: unknown, opts: Record<string, unknown> = {}) => {
    if (opts.body instanceof ReadableStream) sent = Buffer.from(await new Response(opts.body).arrayBuffer());
    return inner(url as string, opts);
  }) as typeof fetch;

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
  assert.equal(calls[1].headers["Content-Length"], "4");
  assert.deepEqual([...sent], [0, 1, 2, 3]);
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

function filesResponder(call: Call): Response {
  if (call.url === "https://api2.skool.com/files" && call.method === "POST") {
    const n = (call.body as { file_name: string }).file_name;
    return jsonOk({
      file: { id: `file-${n}` },
      write_url: `https://s3.example.test/put/${n}`,
      acl: "public-read",
      content_type: "image/png",
      wait_token: "w",
    });
  }
  if (call.url.startsWith("https://api2.skool.com/files?ids=")) {
    return jsonOk({ files: [{ postprocessed_at: "2026-10-28T00:00:00Z", metadata: { read_url: "https://assets.example.test/x" } }] });
  }
  if (call.url.startsWith("https://api2.skool.com/posts")) return jsonOk({ id: "post-1" });
  return new Response("", { status: 200 });
}

test("create post uploads each image via /files and attaches the ids", async () => {
  const a = join(home, "a.png");
  const b = join(home, "b.JPG");
  writeFileSync(a, Buffer.from([1, 2, 3]));
  writeFileSync(b, Buffer.from([4, 5]));
  mockFetch(filesResponder);
  const sent = drainUploads();
  const output = await posts.postsCreateTool.handler({ groupId: GROUP, title: "T", content: "C", images: [a, b], attachmentIds: ["existing"] });
  assert.deepEqual(JSON.parse(output), {
    post: { id: "post-1" },
    imageStatuses: [
      { fileId: "file-a.png", path: a, status: "processed" },
      { fileId: "file-b.JPG", path: b, status: "processed" },
    ],
  });

  const reg = calls.filter((c) => c.url === "https://api2.skool.com/files");
  assert.equal(reg.length, 2);
  assert.deepEqual(reg[0].body, {
    file_name: "a.png",
    content_type: "image/png",
    content_length: 3,
    content_disposition: "",
    ref: "",
    owner_id: GROUP,
    large_thumbnail: false,
  });
  assert.equal((reg[1].body as { content_type: string }).content_type, "image/jpeg");

  const puts = calls.filter((c) => c.method === "PUT");
  assert.equal(puts.length, 2);
  assert.equal(puts[0].url, "https://s3.example.test/put/a.png");
  assert.equal(puts[0].headers["x-amz-acl"], "public-read");
  assert.equal(puts[0].headers["Content-Type"], "image/png");
  assert.equal(puts[0].headers.Cookie, undefined);
  assert.deepEqual(sent.map((bytes) => [...bytes]), [[1, 2, 3], [4, 5]]);

  const create = calls[calls.length - 1];
  assert.equal(create.url, "https://api2.skool.com/posts?notify=false&follow=true");
  const meta = (create.body as { metadata: Record<string, unknown> }).metadata;
  assert.equal(meta.attachments, "existing,file-a.png,file-b.JPG");
  // Post is created only after every upload finished.
  assert.equal(calls.indexOf(create), calls.length - 1);
});

test("create post reports images still processing after the poll limit", async () => {
  const image = join(home, "slow.png");
  writeFileSync(image, Buffer.from([1, 2, 3]));
  mockFetch((call) => {
    if (call.url.startsWith("https://api2.skool.com/files?ids=")) return jsonOk({ files: [{}] });
    return filesResponder(call);
  });
  drainUploads();
  const output = await posts.postsCreateTool.handler({ groupId: GROUP, title: "T", content: "C", images: [image] });

  assert.deepEqual(JSON.parse(output), {
    post: { id: "post-1" },
    imageStatuses: [{ fileId: "file-slow.png", path: image, status: "stillProcessing" }],
  });
  assert.equal(calls.filter((call) => call.url.startsWith("https://api2.skool.com/files?ids=")).length, 15);
  const create = calls[calls.length - 1];
  assert.equal(create.url, "https://api2.skool.com/posts?notify=false&follow=true");
  assert.equal((create.body as { metadata: { attachments: string } }).metadata.attachments, "file-slow.png");
});

test("unavailable image status still creates the post and reports status unknown", async () => {
  const scenarios = [
    { name: "http-error", response: () => new Response("status unavailable", { status: 500 }) },
    { name: "empty", response: () => jsonOk({ files: [] }) },
    { name: "timeout", response: (): Response => { throw new Error("status timeout"); } },
  ];
  for (const scenario of scenarios) {
    const image = join(home, `status-${scenario.name}.png`);
    writeFileSync(image, Buffer.from([1, 2, 3]));
    mockFetch((call) => {
      if (call.url.startsWith("https://api2.skool.com/files?ids=")) return scenario.response();
      return filesResponder(call);
    });
    drainUploads();
    const output = await posts.postsCreateTool.handler({ groupId: GROUP, title: "T", content: "C", images: [image] });
    assert.deepEqual(JSON.parse(output), {
      post: { id: "post-1" },
      imageStatuses: [{ fileId: `file-status-${scenario.name}.png`, path: image, status: "statusUnknown" }],
    });
    assert.equal(calls.filter((call) => call.url.startsWith("https://api2.skool.com/files?ids=")).length, 1);
    assert.equal(calls[calls.length - 1].url, "https://api2.skool.com/posts?notify=false&follow=true");
  }
});

test("create post permits 11 existing attachment ids without images", async () => {
  const attachmentIds = Array.from({ length: 11 }, (_, i) => `existing-${i}`);
  mockFetch(filesResponder);
  await posts.postsCreateTool.handler({ groupId: GROUP, title: "T", content: "C", attachmentIds });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api2.skool.com/posts?notify=false&follow=true");
  assert.equal((calls[0].body as { metadata: { attachments: string } }).metadata.attachments, attachmentIds.join(","));
});

test("images plus attachment ids over 10 are rejected before any HTTP call", async () => {
  mockFetch(filesResponder);
  await assert.rejects(
    () => posts.postsCreateTool.handler({
      groupId: GROUP,
      title: "T",
      content: "C",
      images: [join(home, "not-created.png")],
      attachmentIds: Array.from({ length: 10 }, (_, i) => `existing-${i}`),
    }),
    /at most 10 images/,
  );
  assert.equal(calls.length, 0);
});

test("create post without images makes no /files calls", async () => {
  mockFetch(filesResponder);
  await posts.postsCreateTool.handler({ groupId: GROUP, title: "T", content: "C" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api2.skool.com/posts?notify=false&follow=true");
});

test("bad image inputs are rejected before any HTTP call", async () => {
  mockFetch(filesResponder);
  const txt = join(home, "doc.txt");
  writeFileSync(txt, "x");
  await assert.rejects(() => posts.postsCreateTool.handler({ groupId: GROUP, title: "T", content: "C", images: [txt] }), /Cannot determine image content type/);
  await assert.rejects(
    () => posts.postsCreateTool.handler({ groupId: GROUP, title: "T", content: "C", images: Array.from({ length: 11 }, () => "x.png") }),
    /at most 10 images/,
  );
  await assert.rejects(
    () => posts.postsCreateTool.handler({ groupId: GROUP, title: "T", content: "C", images: [join(home, "a.png")], videoLink: "https://example.com/v" }),
    /Unsupported video link/,
  );
  const empty = join(home, "empty.png");
  writeFileSync(empty, "");
  await assert.rejects(() => posts.postsCreateTool.handler({ groupId: GROUP, title: "T", content: "C", images: [empty] }), /Image file is empty/);
  assert.equal(calls.length, 0);
});

test("all images are checked before the first upload", async () => {
  const valid = join(home, "preflight-valid.png");
  const empty = join(home, "preflight-empty.png");
  writeFileSync(valid, Buffer.from([1]));
  writeFileSync(empty, "");
  mockFetch(filesResponder);
  await assert.rejects(
    () => posts.postsCreateTool.handler({ groupId: GROUP, title: "T", content: "C", images: [valid, empty] }),
    /Image file is empty/,
  );
  await assert.rejects(
    () => posts.postsCreateTool.handler({ groupId: GROUP, title: "T", content: "C", images: [valid, join(home, "preflight-missing.png")] }),
    /Image file not found or not readable/,
  );
  assert.equal(calls.length, 0);
});
