// The Node entry and its modules must load. A module that is imported but not
// shipped leaves the Mini App unable to start, and no manifest check notices.
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('the node entry and its modules load', async () => {
  const entry = await import('../miniapp/node/server.mjs');
  assert.equal(typeof entry.start, 'function');

  const service = await import('../miniapp/node/oauth-service.mjs');
  assert.equal(typeof service.createOAuthService, 'function');
  assert.equal(typeof service.assertTargetUrl, 'function');
  assert.equal(typeof service.credentialPath, 'function');

  const errors = await import('../miniapp/node/errors.mjs');
  assert.equal(typeof errors.serviceError, 'function');
  assert.equal(typeof errors.describeServiceError, 'function');
});

test('every code the service throws is registered in the catalog', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../miniapp/node/oauth-service.mjs', import.meta.url), 'utf8');
  const { isKnownServiceError } = await import('../miniapp/node/errors.mjs');

  const used = [...source.matchAll(/serviceError\(\s*'([a-z0-9_]+)'/g)].map((m) => m[1]);
  assert.ok(used.length > 0, 'expected the service to throw catalogued codes');
  const unknown = [...new Set(used)].filter((code) => !isKnownServiceError(code));
  assert.deepEqual(unknown, [], `unregistered error codes: ${unknown.join(', ')}`);
});

test('no node file throws a raw code that would reach the page', async () => {
  const { readFile, readdir } = await import('node:fs/promises');
  const dir = new URL('../miniapp/node/', import.meta.url);
  const names = await readdir(dir);
  const raw = [];
  for (const name of names) {
    if (!name.endsWith('.mjs')) continue;
    const source = await readFile(new URL(name, dir), 'utf8');
    // A raw `throw new Error('some_code')` bypasses the catalog, so the code
    // would be handed to the page as-is.
    for (const match of source.matchAll(/throw new Error\(\s*'([a-z0-9_]+)'/g)) {
      raw.push(`${name}: ${match[1]}`);
    }
  }
  assert.deepEqual(raw, [], `raw error codes must go through the catalog: ${raw.join(', ')}`);
});
