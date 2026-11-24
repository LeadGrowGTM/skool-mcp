import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'members-test-'));
process.env.HOME = home;
mkdirSync(join(home, '.config', 'skool-mcp'), { recursive: true });
writeFileSync(join(home, '.config', 'skool-mcp', 'config.json'), JSON.stringify({ defaultCommunity: 'fixture', baseUrl: 'https://example.test' }));

test('member tabs request the selected tab and retain its own results', async () => {
  const urls: URL[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = new URL(String(input)); urls.push(url);
    if (url.pathname === '/') return new Response('<script>{"buildId":"fixture"}</script>');
    return Response.json({ pageProps: { users: [{ id: url.searchParams.get('t') }], tabChips: [{ key: 'churned', activeLabel: '0' }] } });
  }) as typeof fetch;
  try {
    const { membersListTool } = await import('../src/tools/members.ts');
    for (const tab of ['active', 'cancelling', 'churned', 'banned'] as const) {
      const result = JSON.parse(await membersListTool.handler({ page: 2, tab }));
      assert.equal(result.users[0].id, tab);
      const url = urls.at(-1)!;
      assert.equal(url.searchParams.get('t'), tab);
      assert.equal(url.searchParams.get('p'), '2');
    }
    assert.equal(membersListTool.inputSchema.tab.safeParse('unknown').success, false);
  } finally { globalThis.fetch = original; }
});
