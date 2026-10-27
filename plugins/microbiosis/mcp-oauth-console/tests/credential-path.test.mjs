// A server name becomes a file name, so it must never be able to leave the
// credential directory.
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';

import { assertServerName, credentialPath } from '../miniapp/node/oauth-service.mjs';

const dir = join(tmpdir(), 'mcp-oauth-console-credential-test');

test('ordinary names are accepted', () => {
  for (const name of ['hf-endpoints', 'exa', 'my.server', 'a_b-c']) {
    assert.equal(assertServerName(name), name);
    const path = credentialPath(name, dir);
    assert.ok(path.startsWith(resolve(dir) + sep));
  }
});

test('names that could walk out of the directory are refused', () => {
  for (const name of ['..', '.', '../../other', 'a/b', 'a\\b', '', 'x'.repeat(65), 'a b']) {
    assert.throws(() => assertServerName(name), undefined, `expected a refusal for ${JSON.stringify(name)}`);
    assert.throws(() => credentialPath(name, dir), undefined, `expected a refusal for ${JSON.stringify(name)}`);
  }
});

test('the resolved path always stays inside the directory', () => {
  const path = credentialPath('hf-endpoints', dir);
  assert.equal(path, join(resolve(dir), 'hf-endpoints.json'));
});
