// The Host MCP configuration is written surgically: only the Authorization
// header of the target entry changes, and the rest of the file stays
// byte-identical.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createOAuthService } from '../miniapp/node/oauth-service.mjs';

const CONFIG = `{
  "mcpServers": {
    "with-auth": {
      "type": "streamable-http",
      "url": "https://example.com/mcp",
      "headers": {
        "Authorization": "Bearer old-token"
      }
    },
    "with-other-key": {
      "type": "streamable-http",
      "url": "https://example.org/mcp",
      "headers": {
        "x-api-key": "secret-key"
      }
    },
    "without-headers": {
      "type": "streamable-http",
      "url": "https://example.net/mcp"
    }
  },
  "otherTopLevel": {
    "Authorization": "Bearer must-not-be-touched"
  }
}
`;

async function makeService() {
  const root = await mkdtemp(join(tmpdir(), 'mcp-oauth-console-patch-'));
  const dataDir = join(root, 'data');
  await writeFile(join(root, 'mcp.json'), CONFIG, 'utf8');
  const service = createOAuthService({ dataDir, baseUrl: 'http://127.0.0.1:39999', logger: { debug() {}, info() {}, warn() {}, error() {} } });
  return { root, service };
}

test('an existing Authorization header is replaced in place', async () => {
  const { root, service } = await makeService();
  const before = await readFile(join(root, 'mcp.json'), 'utf8');
  const result = await service.writeAuthorization('with-auth', 'new-token', { url: 'https://example.com/mcp' });
  const after = await readFile(join(root, 'mcp.json'), 'utf8');

  assert.equal(result.replaced, true);
  assert.equal(result.created, false);
  assert.ok(after.includes('"Bearer new-token"'));
  assert.ok(!after.includes('Bearer old-token'));
  const changed = before.split('\n').filter((line, index) => line !== after.split('\n')[index]);
  assert.equal(changed.length, 1, 'exactly one line may change');
  service.dispose();
});

test('an entry with another key keeps it and gains an Authorization header', async () => {
  const { root, service } = await makeService();
  const before = await readFile(join(root, 'mcp.json'), 'utf8');
  await service.writeAuthorization('with-other-key', 'new-token', { url: 'https://example.org/mcp' });
  const after = await readFile(join(root, 'mcp.json'), 'utf8');

  assert.ok(after.includes('"x-api-key": "secret-key"'), 'the existing key must survive');
  assert.ok(after.includes('"Authorization": "Bearer new-token"'));
  const changed = before.split('\n').filter((line, index) => line !== after.split('\n')[index]);
  assert.ok(changed.length <= 2, `only the headers block may change, got ${changed.length} lines`);
  service.dispose();
});

test('an entry without headers gains one, and unrelated entries stay untouched', async () => {
  const { root, service } = await makeService();
  const before = await readFile(join(root, 'mcp.json'), 'utf8');
  await service.writeAuthorization('without-headers', 'new-token', { url: 'https://example.net/mcp' });
  const after = await readFile(join(root, 'mcp.json'), 'utf8');

  assert.ok(after.includes('"headers"'));
  assert.ok(after.includes('"Authorization": "Bearer new-token"'));
  assert.ok(after.includes('"Bearer must-not-be-touched"'), 'another top level key must stay');
  assert.ok(before.includes('"Bearer must-not-be-touched"'));
  service.dispose();
});

test('a new entry is inserted without rewriting the rest of the file', async () => {
  const { root, service } = await makeService();
  const before = await readFile(join(root, 'mcp.json'), 'utf8');
  const result = await service.writeAuthorization('brand-new', 'new-token', { url: 'https://example.dev/mcp' });
  const after = await readFile(join(root, 'mcp.json'), 'utf8');

  assert.equal(result.created, true);
  assert.ok(after.includes('"brand-new"'));
  assert.ok(after.includes('"Bearer must-not-be-touched"'));
  const parsed = JSON.parse(after);
  assert.equal(parsed.mcpServers['brand-new'].headers.Authorization, 'Bearer new-token');
  assert.equal(parsed.mcpServers['with-auth'].headers.Authorization, 'Bearer old-token');
  service.dispose();
});
