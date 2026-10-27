// One guard for every outbound request. A hostile server must not be able to
// point this Mini App at the network around the machine.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assertMetadataUrl, assertTargetUrl, isPrivateHost } from '../miniapp/node/oauth-service.mjs';

const blocked = [
  ['http://example.com/mcp', 'plain http'],
  ['https://user:pass@example.com/mcp', 'credentials in the url'],
  ['https://10.1.2.3/mcp', 'rfc1918 10/8'],
  ['https://192.168.0.5/mcp', 'rfc1918 192.168/16'],
  ['https://172.16.9.9/mcp', 'rfc1918 172.16/12'],
  ['https://127.0.0.1/mcp', 'loopback'],
  ['https://169.254.169.254/latest/meta-data', 'instance metadata'],
  ['https://169.254.10.10/mcp', 'link local'],
  ['https://[::1]/mcp', 'ipv6 loopback'],
  ['https://[::ffff:127.0.0.1]/mcp', 'ipv4 mapped loopback'],
  ['https://[::ffff:7f00:1]/mcp', 'ipv4 mapped loopback in the hex form a url parser produces'],
  ['https://[::ffff:a00:1]/mcp', 'ipv4 mapped rfc1918'],
  ['https://[64:ff9b::7f00:1]/mcp', 'nat64 loopback'],
  ['https://[fd00::1]/mcp', 'ipv6 unique local'],
  ['https://[fe80::1]/mcp', 'ipv6 link local'],
  ['https://metadata.google.internal/mcp', 'gcp metadata'],
];

test('private and metadata targets are refused', () => {
  for (const [url, label] of blocked) {
    assert.throws(() => assertTargetUrl(url), undefined, `expected a refusal for ${label}: ${url}`);
    assert.throws(() => assertMetadataUrl(url), undefined, `expected a refusal for ${label}: ${url}`);
  }
});

test('a remote url that carries a private address is refused even when private networks are allowed', () => {
  assert.throws(
    () => assertMetadataUrl('https://10.0.0.5/oauth/token'),
    undefined,
    'metadata urls must never reach a private address',
  );
});

test('https public targets pass', () => {
  assert.ok(assertTargetUrl('https://endpoints.huggingface.co/mcp'));
  assert.ok(assertMetadataUrl('https://huggingface.co/.well-known/oauth-authorization-server'));
});

test('the user may opt into private addresses for their own endpoint', () => {
  assert.ok(assertTargetUrl('http://127.0.0.1:3000/mcp', { allowPrivateNetwork: true }));
  assert.ok(assertTargetUrl('https://192.168.1.10/mcp', { allowPrivateNetwork: true }));
});

test('isPrivateHost classifies the usual ranges', () => {
  assert.equal(isPrivateHost('127.0.0.1'), true);
  assert.equal(isPrivateHost('::ffff:10.0.0.1'), true);
  assert.equal(isPrivateHost('::ffff:7f00:1'), true);
  assert.equal(isPrivateHost('64:ff9b::7f00:1'), true);
  assert.equal(isPrivateHost('::ffff:808:808'), false);
  assert.equal(isPrivateHost('example.com'), false);
  assert.equal(isPrivateHost('huggingface.co'), false);
});
