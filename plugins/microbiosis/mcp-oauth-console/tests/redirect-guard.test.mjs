// A redirect must not be a way around the URL guard, and it must not carry a
// credential to a host that did not receive it. `fetch` follows a redirect on
// its own, so every hop is checked again before it is requested.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';

import {
  assertMetadataUrl,
  assertTargetUrl,
  guardedRequest,
  resolveRedirectTarget,
} from '../miniapp/node/oauth-service.mjs';

/**
 * Runs the guarded request and returns the error the guard raised.
 *
 * A port that was taken between the bind and the connect shows up as a
 * connection error, which is not what this test is about, so it is retried
 * instead of being reported as a failure of the guard.
 */
async function requestUntilRefused(url, guard) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await guardedRequest(url, {}, { guard });
      return null;
    } catch (error) {
      lastError = error;
      if (error instanceof Error && /blocked|target_url/.test(error.message)) return error;
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
  }
  throw lastError;
}

test('a redirect to a private address is refused', () => {
  const hops = [
    ['http://169.254.169.254/latest/meta-data', 'instance metadata'],
    ['http://127.0.0.1:8080/mcp', 'loopback'],
    ['http://10.0.0.5/mcp', 'rfc1918'],
    ['http://[::1]:8080/mcp', 'ipv6 loopback'],
  ];
  for (const [location, label] of hops) {
    assert.throws(
      () => resolveRedirectTarget('https://example.com/mcp', location, assertMetadataUrl),
      undefined,
      `expected a refusal for ${label}`,
    );
  }
});

test('a redirect to a public address is accepted', () => {
  assert.equal(
    resolveRedirectTarget('https://example.com/mcp', 'https://example.net/mcp', assertMetadataUrl),
    'https://example.net/mcp',
  );
});

test('a relative redirect stays on the same host', () => {
  assert.equal(
    resolveRedirectTarget('https://example.com/mcp', '/other', assertMetadataUrl),
    'https://example.com/other',
  );
});

test('the redirected host is never requested when the guard refuses the hop', async () => {
  let hits = 0;
  const secret = createServer((_request, response) => {
    hits += 1;
    response.writeHead(200).end('secret');
  });
  await new Promise((resolve) => secret.listen(0, '127.0.0.1', resolve));
  const secretPort = secret.address().port;

  const redirector = createServer((_request, response) => {
    response.writeHead(302, { location: `http://127.0.0.1:${secretPort}/secret` }).end();
  });
  await new Promise((resolve) => redirector.listen(0, '127.0.0.1', resolve));
  const redirectorPort = redirector.address().port;

  try {
    const allowed = `http://127.0.0.1:${redirectorPort}/`;
    // The guard lets the first URL through and refuses anything else.
    const guard = (url) => {
      if (url !== allowed) throw new Error('blocked');
    };
    const error = await requestUntilRefused(allowed, guard);
    assert.ok(error, 'the refused hop must stop the request');
    assert.equal(hits, 0, 'the refused hop must never be requested');
  } finally {
    secret.closeAllConnections?.();
    redirector.closeAllConnections?.();
    await new Promise((resolve) => secret.close(resolve));
    await new Promise((resolve) => redirector.close(resolve));
  }
});

test('the endpoint guard refuses a private hop even when the first URL is allowed', async () => {
  const redirector = createServer((_request, response) => {
    response.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' }).end();
  });
  await new Promise((resolve) => redirector.listen(0, '127.0.0.1', resolve));
  const port = redirector.address().port;
  const first = `http://127.0.0.1:${port}/`;
  try {
    // The first URL is the loopback the user pointed at; the hop is not.
    const guard = (url) => {
      if (url === first) return;
      assertTargetUrl(url, { allowPrivateNetwork: false });
    };
    const error = await requestUntilRefused(first, guard);
    assert.ok(error, 'a private hop must stop the request');
    assert.match(error.message, /target_url/);
  } finally {
    redirector.closeAllConnections?.();
    await new Promise((resolve) => redirector.close(resolve));
  }
});

test('a cross-origin redirect does not carry the Authorization header', async () => {
  let seen = null;
  const other = createServer((request, response) => {
    seen = { authorization: request.headers.authorization ?? null, cookie: request.headers.cookie ?? null };
    response.writeHead(200).end('ok');
  });
  await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve));
  const otherPort = other.address().port;

  const redirector = createServer((_request, response) => {
    response.writeHead(302, { location: `http://127.0.0.1:${otherPort}/target` }).end();
  });
  await new Promise((resolve) => redirector.listen(0, '127.0.0.1', resolve));
  const redirectorPort = redirector.address().port;

  try {
    const first = `http://127.0.0.1:${redirectorPort}/`;
    await guardedRequest(
      first,
      {
        method: 'POST',
        headers: { authorization: 'Bearer secret-token', cookie: 'session=abc', 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
      },
      { guard: (url) => { if (url !== first && !url.includes(`:${otherPort}`)) throw new Error('blocked'); } },
    );
    assert.ok(seen, 'the redirect target must have been reached');
    assert.equal(seen.authorization, null, 'the token must not travel to another origin');
    assert.equal(seen.cookie, null, 'the cookie must not travel to another origin');
  } finally {
    other.closeAllConnections?.();
    redirector.closeAllConnections?.();
    await new Promise((resolve) => other.close(resolve));
    await new Promise((resolve) => redirector.close(resolve));
  }
});

test('a request whose body holds a secret is never redirected', async () => {
  let hits = 0;
  const other = createServer((request, response) => {
    hits += 1;
    response.writeHead(200).end(JSON.stringify({ leaked: request.body ?? null }));
  });
  await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve));
  const otherPort = other.address().port;

  const redirector = createServer((_request, response) => {
    response.writeHead(302, { location: `http://127.0.0.1:${otherPort}/token` }).end();
  });
  await new Promise((resolve) => redirector.listen(0, '127.0.0.1', resolve));
  const redirectorPort = redirector.address().port;

  try {
    const first = `http://127.0.0.1:${redirectorPort}/token`;
    await assert.rejects(
      () =>
        guardedRequest(
          first,
          {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: 'grant_type=refresh_token&refresh_token=the-secret',
          },
          { guard: () => {}, sensitive: true },
        ),
      /redirect_not_allowed/,
    );
    assert.equal(hits, 0, 'the body must never be re-sent to the redirect target');
  } finally {
    other.closeAllConnections?.();
    redirector.closeAllConnections?.();
    await new Promise((resolve) => other.close(resolve));
    await new Promise((resolve) => redirector.close(resolve));
  }
});
