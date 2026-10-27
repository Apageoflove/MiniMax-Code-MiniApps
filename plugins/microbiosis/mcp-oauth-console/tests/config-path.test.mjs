// The search for `mcp.json` stops at the MiniMax data directory: an
// `mcp.json` one level above it belongs to something else.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { resolveMcpConfigPath } from '../miniapp/node/oauth-service.mjs';

async function makeLayout() {
  const root = await mkdtemp(join(tmpdir(), 'mcp-oauth-console-config-'));
  const minimax = join(root, '.minimax');
  const dataDir = join(minimax, 'v2', 'plugin-data', 'liveboards', 'mcp-oauth-console');
  await mkdir(dataDir, { recursive: true });
  // An unrelated configuration one level above the MiniMax data directory.
  await writeFile(join(root, 'mcp.json'), '{}', 'utf8');
  return { root, minimax, dataDir };
}

test('the configuration inside the MiniMax data directory wins', async () => {
  const { minimax, dataDir } = await makeLayout();
  const expected = join(minimax, 'mcp.json');
  await writeFile(expected, '{}', 'utf8');
  assert.equal(resolveMcpConfigPath(dataDir), expected);
});

test('an unrelated configuration above the MiniMax data directory is not used', async () => {
  const { root, dataDir } = await makeLayout();
  const resolved = resolveMcpConfigPath(dataDir);
  assert.notEqual(resolved, join(root, 'mcp.json'), 'the unrelated file must not be used');
  assert.equal(resolved, join(homedir(), '.minimax', 'mcp.json'));
});
