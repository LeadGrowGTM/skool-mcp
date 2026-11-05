import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const home = mkdtempSync(join(tmpdir(), 'lesson-test-'));
process.env.HOME = home;
mkdirSync(join(home, '.config/skool-mcp'), { recursive: true });
writeFileSync(join(home, '.config/skool-mcp/config.json'), JSON.stringify({ cookies: 'fake=test' }));
const { lessonsSetVideoTool } = await import('../src/tools/classroom.js');
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
after(() => rmSync(home, { recursive: true, force: true }));
test('lesson video full PUT preserves fields and sets optional link', async () => {
 const lesson = { title: 'T', desc: '', resources: [], transcript: null, privacy: 3, min_tier: 2, state: 0, extra: 'keep' };
 const methods: string[] = [];
 globalThis.fetch = (async (_url, opts = {}) => {
   methods.push(opts.method ?? 'GET');
   if (opts.method === 'PUT') assert.deepEqual(JSON.parse(opts.body as string), { ...lesson, video_id: 'v', video_link: 'https://vimeo.com/1' });
   return new Response(JSON.stringify({ data: lesson }));
 }) as typeof fetch;
 await lessonsSetVideoTool.handler({ lessonId: 'a'.repeat(32), videoId: 'v', videoLink: 'https://vimeo.com/1' });
 assert.deepEqual(methods, ['GET', 'PUT']);
});
test('invalid IDs never fetch; incomplete lesson read never PUTs', async () => {
 let count = 0;
 globalThis.fetch = (async () => { count++; return new Response('{}'); }) as typeof fetch;
 await assert.rejects(() => lessonsSetVideoTool.handler({ lessonId: 'bad', videoId: 'v' }));
 assert.equal(count, 0);
 await assert.rejects(() => lessonsSetVideoTool.handler({ lessonId: 'a'.repeat(32), videoId: 'v' }), /missing fields/);
 assert.equal(count, 1);
});
