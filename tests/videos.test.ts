import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const home = mkdtempSync(join(tmpdir(), 'video-test-'));
process.env.HOME = home;
mkdirSync(join(home, '.config/skool-mcp'), { recursive: true });
writeFileSync(join(home, '.config/skool-mcp/config.json'), JSON.stringify({ cookies: 'fake=test' }));
const { uploadVideoTool, MAX_VIDEO_BYTES } = await import('../src/tools/videos.js');
const { VIDEO_CHUNK_BYTES } = await import('../src/client.js');
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
after(() => rmSync(home, { recursive: true, force: true }));
const lessonId = 'a'.repeat(32);
const lesson = { title: 'Private', desc: 'Description', resources: [{ id: 'r' }], transcript: 'words', privacy: 2, min_tier: 3, state: 1 };
function json(value: unknown) { return new Response(JSON.stringify(value)); }
test('source without Content-Length downloads without cookies and attaches a full lesson after upload', async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (url, opts = {}) => {
    const target = String(url); calls.push(`${opts.method ?? 'GET'} ${target}`);
    if (target === 'https://source.test/clip.mp4') {
      assert.equal(new Headers(opts.headers).has('cookie'), false);
      return new Response(new Uint8Array([1, 2, 3]));
    }
    if (opts.method === 'POST') {
      assert.equal(JSON.parse(opts.body as string).reference_type, 'module');
      return json({ id: 'video', upload_url: 'https://upload.test/video' });
    }
    if (target === 'https://upload.test/video') {
      assert.equal(new Headers(opts.headers).has('cookie'), false);
      assert.deepEqual([...new Uint8Array(await new Response(opts.body).arrayBuffer())], [1, 2, 3]);
      return new Response('');
    }
    if (opts.method === 'PUT') {
      assert.deepEqual(JSON.parse(opts.body as string), { ...lesson, video_id: 'video' });
      return json({});
    }
    return json(lesson);
  }) as typeof fetch;
  const out = JSON.parse(await uploadVideoTool.handler({ groupId: 'g', sourceUrl: 'https://source.test/clip.mp4', lessonId }));
  assert.equal(out.lessonAttached, true);
  assert.deepEqual(calls.map(c => c.split(' ')[0]), ['GET', 'POST', 'PUT', 'GET', 'PUT']);
  assert.equal(calls[4], `PUT https://api2.skool.com/courses/${lessonId}`);
});
test('invalid local inputs and XOR reject before HTTP', async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error('Unexpected fetch'); }) as typeof fetch;
  const empty = join(home, 'empty.mp4'); writeFileSync(empty, '');
  const huge = join(home, 'huge.mp4'); writeFileSync(huge, ''); truncateSync(huge, MAX_VIDEO_BYTES);
  for (const args of [ {}, { filePath: empty, sourceUrl: 'https://source.test/a.mp4' }, { filePath: empty }, { filePath: huge }, { filePath: join(home, 'missing.mp4') }, { filePath: empty, fileName: 'bad.txt', contentType: 'video/mp4' }, { sourceUrl: 'file:///clip.mp4' }, { filePath: empty, lessonId: 'bad' } ]) {
    await assert.rejects(() => uploadVideoTool.handler({ groupId: 'g', ...args }));
  }
  assert.equal(calls, 0);
});
test('small upload is one PUT; large upload uses ranges and retries the same chunk', async () => {
  for (const size of [4, VIDEO_CHUNK_BYTES + 3]) {
    const filePath = join(home, 'chunk.mp4'); writeFileSync(filePath, Buffer.alloc(size, 7));
    const ranges: (string | null)[] = [];
    let failed = false;
    globalThis.fetch = (async (_url, opts = {}) => {
      if (opts.method === 'POST') return json({ id: 'v', uploadUrl: 'https://upload.test/v' });
      const range = new Headers(opts.headers).get('content-range'); ranges.push(range);
      assert.equal(new Headers(opts.headers).has('cookie'), false);
      const bytes = await new Response(opts.body).arrayBuffer();
      assert.ok(bytes.byteLength <= VIDEO_CHUNK_BYTES);
      if (range && !failed) { failed = true; return new Response('', { status: 500 }); }
      return new Response('', { status: range?.startsWith('bytes 0-') ? 308 : 200 });
    }) as typeof fetch;
    await uploadVideoTool.handler({ groupId: 'g', filePath });
    assert.deepEqual(ranges, size === 4 ? [null] : [`bytes 0-${VIDEO_CHUNK_BYTES - 1}/${size}`, `bytes 0-${VIDEO_CHUNK_BYTES - 1}/${size}`, `bytes ${VIDEO_CHUNK_BYTES}-${size - 1}/${size}`]);
  }
});
test('source with Content-Length uploads; empty, oversized and truncated sources never register', async () => {
  for (const declared of ['3', '0', String(MAX_VIDEO_BYTES), '4']) {
    let registered = 0;
    globalThis.fetch = (async (url, opts = {}) => {
      if (String(url).startsWith('https://source.test')) return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Length': declared } });
      if (opts.method === 'POST') { registered++; return json({ id: 'v', uploadUrl: 'https://upload.test/v' }); }
      await new Response(opts.body).arrayBuffer();
      return new Response('');
    }) as typeof fetch;
    const upload = () => uploadVideoTool.handler({ groupId: 'g', sourceUrl: 'https://source.test/clip.mp4' });
    if (declared === '3') { await upload(); assert.equal(registered, 1); }
    else { await assert.rejects(upload); assert.equal(registered, 0); }
  }
});
test('chunk failure stops after three retries without attaching', async () => {
 const filePath = join(home, 'retry.mp4'); writeFileSync(filePath, Buffer.alloc(VIDEO_CHUNK_BYTES + 1));
 let attempts = 0;
 globalThis.fetch = (async (_url, opts = {}) => {
   if (opts.method === 'POST') return json({ id: 'v', uploadUrl: 'https://upload.test/v' });
   attempts++;
   return new Response('', { status: 500 });
 }) as typeof fetch;
 await assert.rejects(() => uploadVideoTool.handler({ groupId: 'g', filePath, lessonId }), /three retries/);
 assert.equal(attempts, 4);
});
