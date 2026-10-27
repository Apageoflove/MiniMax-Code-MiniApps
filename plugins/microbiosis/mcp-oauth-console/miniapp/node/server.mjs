// @ts-check

/**
 * Mini App HTTP entry for the MCP OAuth console.
 *
 * Serves the Client surface plus a narrow business API. Every mutation is
 * delegated to the OAuth domain service, which owns the credential file and
 * the `mcp.json` patch. Nothing here echoes token material back to the page.
 */

import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

import { createOAuthService } from './oauth-service.mjs';
import { describeServiceError, isKnownServiceError } from './errors.mjs';

/** @typedef {import('./miniapp-api.js').MiniAppContext} MiniAppContext */
/** @typedef {import('./miniapp-api.js').MiniAppLifecycle} MiniAppLifecycle */

const SURFACE_PATH = '/console';
const CALLBACK_PATH = '/oauth/callback';
const REFRESH_INTERVAL_MS = 60 * 1000;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/**
 * @param {MiniAppContext} context
 * @returns {Promise<MiniAppLifecycle>}
 */
export async function start(context) {
  const clientDir = join(context.pluginRoot, 'miniapp', 'client');
  const baseUrl = `http://127.0.0.1:${context.listen.port}`;

  /** @type {Set<import('node:http').ServerResponse>} */
  const listeners = new Set();

  const broadcast = (event, payload) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const response of listeners) {
      try {
        response.write(frame);
      } catch {
        listeners.delete(response);
      }
    }
  };

  const service = createOAuthService({
    dataDir: context.dataDir,
    baseUrl,
    logger: context.logger,
    onChange: () => broadcast('state', { reason: 'service' }),
  });

  const sendJson = (response, status, body) => {
    const text = JSON.stringify(body);
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(text);
  };

  /**
   * Resolves a domain error code through the shared catalog: the catalog owns
   * the HTTP status and the user-facing text, so the Client never has to
   * re-describe a code and a precise reason is never collapsed into a generic
   * "internal error".
   */
  const fail = (response, code) => {
    const { status, message } = describeServiceError(code);
    if (!isKnownServiceError(code)) {
      context.logger.warn(`miniapp.request.unregistered_error_code code=${code}`);
    }
    sendJson(response, status, { ok: false, error: code, message });
  };

  const readBody = async (request) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    if (!chunks.length) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return null;
    }
  };

  const server = createServer((request, response) => {
    void handle(request, response).catch((error) => {
      const code = error instanceof Error ? error.message : 'internal_error';
      // Only the keys of `fields` leave the process, so the reason goes in the
      // message itself.
      context.logger.error(`miniapp.request.failed reason=${code}`);
      // An unregistered code is an internal detail: the page gets the generic
      // one, never the raw reason.
      if (!response.headersSent) fail(response, isKnownServiceError(code) ? code : 'internal_error');
      else response.end();
    });
  });

  async function handle(request, response) {
    const url = new URL(request.url ?? '/', 'http://miniapp.local');
    const pathname = url.pathname;
    const method = request.method ?? 'GET';

    if (method === 'GET' && (pathname === SURFACE_PATH || pathname === `${SURFACE_PATH}/`)) {
      const html = await readFile(join(clientDir, 'index.html'));
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(html);
      return;
    }

    if (method === 'GET' && pathname.startsWith('/assets/')) {
      const name = normalize(pathname.slice('/assets/'.length)).replace(/^([/\\])+/, '');
      if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) {
        fail(response, 'not_found');
        return;
      }
      try {
        const file = await readFile(join(clientDir, name));
        response.writeHead(200, {
          'content-type': CONTENT_TYPES[extname(name)] ?? 'application/octet-stream',
          'cache-control': 'no-store',
        });
        response.end(file);
      } catch {
        fail(response, 'not_found');
      }
      return;
    }

    if (method === 'GET' && pathname === '/api/state') {
      const state = await service.buildState();
      sendJson(response, 200, { ok: true, state });
      return;
    }

    if (method === 'GET' && pathname === '/api/events') {
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      response.write('retry: 3000\n\n');
      listeners.add(response);
      request.on('close', () => listeners.delete(response));
      return;
    }

    if (method === 'GET' && pathname === CALLBACK_PATH) {
      const result = await service.handleCallback(url.searchParams);
      response.writeHead(result.ok ? 200 : 400, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(renderCallbackPage(result));
      broadcast('state', { reason: 'authorization' });
      return;
    }

    if (method === 'POST' && pathname === '/api/discover') {
      const body = await readBody(request);
      if (!body) {
        fail(response, 'invalid_json');
        return;
      }
      const { servers } = await service.listConfiguredServers();
      const server = servers.find((item) => item.name === body.serverName);
      if (!server) {
        fail(response, 'server_not_found');
        return;
      }
      if (!server.url) {
        fail(response, 'server_without_url');
        return;
      }
      const discovery = await service.probeDiscovery(server.name, server.url, server.type);
      sendJson(response, 200, {
        ok: true,
        discovery: {
          oauthProtected: discovery.oauthProtected,
          authRequirement: discovery.authRequirement ?? 'unknown',
          status: discovery.status,
          authorizationServer: discovery.authorizationServer,
          scopes: discovery.scopes ?? [],
          dynamicRegistration: Boolean(discovery.metadata?.registration_endpoint),
          authorizationEndpoint: discovery.metadata?.authorization_endpoint ?? null,
          tokenEndpoint: discovery.metadata?.token_endpoint ?? null,
          reason: discovery.reason ?? null,
          reasonMessage: discovery.reason ? describeServiceError(discovery.reason).message : null,
        },
      });
      return;
    }

    if (method === 'POST' && pathname === '/api/authorize') {
      const body = await readBody(request);
      if (!body) {
        fail(response, 'invalid_json');
        return;
      }
      const result = await service.startAuthorization({
        serverName: String(body.serverName ?? ''),
        url: body.url ? String(body.url) : undefined,
        scope: body.scope ? String(body.scope) : undefined,
      });
      sendJson(response, 200, { ok: true, ...result });
      return;
    }

    if (method === 'POST' && pathname === '/api/device/start') {
      const body = await readBody(request);
      if (!body) {
        fail(response, 'invalid_json');
        return;
      }
      const result = await service.startDeviceAuthorization({
        serverName: String(body.serverName ?? ''),
        url: body.url ? String(body.url) : undefined,
        scope: body.scope ? String(body.scope) : undefined,
      });
      sendJson(response, 200, { ok: true, ...result });
      return;
    }

    if (method === 'GET' && pathname === '/api/device/status') {
      const serverName = url.searchParams.get('serverName') ?? '';
      sendJson(response, 200, { ok: true, ...service.deviceStatus(serverName) });
      return;
    }

    if (method === 'POST' && pathname === '/api/authorize/complete') {
      const body = await readBody(request);
      if (!body) {
        fail(response, 'invalid_json');
        return;
      }
      const result = await service.completeAuthorization({
        sessionId: String(body.sessionId ?? ''),
        redirectUrl: body.redirectUrl ? String(body.redirectUrl) : undefined,
      });
      broadcast('state', { reason: 'authorization' });
      sendJson(response, 200, { ok: true, ...result });
      return;
    }

    if (method === 'POST' && pathname === '/api/apply') {
      const body = await readBody(request);
      if (!body) {
        fail(response, 'invalid_json');
        return;
      }
      const result = await service.applyGrant(String(body.serverName ?? ''), {
        confirmToken: body.confirmToken ? String(body.confirmToken) : null,
        expectedPath: body.expectedPath ? String(body.expectedPath) : null,
      });
      broadcast('state', { reason: 'applied' });
      sendJson(response, 200, { ok: true, ...result });
      return;
    }

    if (method === 'POST' && pathname === '/api/settings') {
      const body = await readBody(request);
      if (!body) {
        fail(response, 'invalid_json');
        return;
      }
      const settings = await service.saveSettings({
        autoRefresh: body.autoRefresh === true,
        allowPrivateNetwork: body.allowPrivateNetwork === true,
      });
      broadcast('state', { reason: 'settings' });
      sendJson(response, 200, { ok: true, settings });
      return;
    }

    if (method === 'POST' && pathname === '/api/refresh') {
      const body = await readBody(request);
      if (!body) {
        fail(response, 'invalid_json');
        return;
      }
      const result = await service.refreshServer(String(body.serverName ?? ''));
      broadcast('state', { reason: 'refreshed' });
      sendJson(response, 200, { ok: true, ...result });
      return;
    }

    if (method === 'POST' && pathname === '/api/refresh-all') {
      // The user pressed the button, so this one is confirmed even when the
      // background timer is off.
      const results = await service.refreshExpiring({ force: true });
      broadcast('state', { reason: 'refreshed' });
      sendJson(response, 200, { ok: true, results });
      return;
    }

    fail(response, 'not_found');
  }

  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(context.listen.port, context.listen.host, () => {
      server.off('error', onError);
      resolve(undefined);
    });
  });
  context.logger.info(`miniapp.runtime.listening surface=${SURFACE_PATH}`);

  const timer = setInterval(() => {
    void service
      .refreshExpiring()
      .then((results) => {
        if (results.length) broadcast('state', { reason: 'auto-refresh' });
      })
      .catch(() => {
        // background refresh failures are reported per server in the next state
      });
  }, REFRESH_INTERVAL_MS);
  timer.unref?.();

  // Warm the OAuth detection cache in the background; never block readiness.
  void (async () => {
    try {
      const { servers } = await service.listConfiguredServers();
      for (const server of servers) {
        if (!server.url) continue;
        try {
          await service.probeDiscovery(server.name, server.url, server.type);
        } catch {
          // a single unreachable endpoint must not stop the rest of the cache
        }
      }
      broadcast('state', { reason: 'discovery' });
    } catch {
      // discovery cache warms lazily on demand
    }
  })();

  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    clearInterval(timer);
    context.signal.removeEventListener('abort', onAbort);
    for (const response of listeners) {
      try {
        response.end();
      } catch {
        // listener already closed
      }
    }
    listeners.clear();
    service.dispose();
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve(undefined)));
    });
  };
  const onAbort = () => {
    void dispose();
  };
  context.signal.addEventListener('abort', onAbort, { once: true });
  if (context.signal.aborted) await dispose();

  return { dispose };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]);
}

function renderCallbackPage(result) {
  const ok = result.ok;
  // The error text can come from a crafted callback URL, so it is escaped
  // before it reaches the page.
  const title = escapeHtml(ok ? '授权完成' : '授权未完成');
  const detail = escapeHtml(result.message ?? '');
  const tone = ok ? 'var(--mcode-success)' : 'var(--mcode-danger)';
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
    <style>
      :root {
        --mcode-bg: #ffffff;
        --mcode-surface: #ffffff;
        --mcode-text: #171717;
        --mcode-text-muted: #666666;
        --mcode-border: #0a0a0a14;
        --mcode-accent: #0094fc;
        --mcode-success: #04b54b;
        --mcode-danger: #f73646;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --mcode-bg: #171717;
          --mcode-surface: #262626;
          --mcode-text: #ededed;
          --mcode-text-muted: #949494;
          --mcode-border: #ffffff14;
          --mcode-accent: #0077d9;
          --mcode-success: #009c3d;
          --mcode-danger: #e31937;
        }
      }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: var(--mcode-bg);
        color: var(--mcode-text);
        font-family: ui-sans-serif, -apple-system, system-ui, 'Segoe UI', Helvetica, Arial, sans-serif;
      }
      main {
        max-width: 420px;
        padding: 24px;
        background: var(--mcode-surface);
        border: 1px solid var(--mcode-border);
        border-radius: 12px;
      }
      h1 { font-size: 18px; line-height: 28px; font-weight: 600; margin: 0 0 12px; }
      p { font-size: 14px; line-height: 22px; color: var(--mcode-text-muted); margin: 0; }
      .mark { display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: ${tone}; margin-right: 8px; }
    </style>
  </head>
  <body>
    <main>
      <h1><span class="mark"></span>${title}</h1>
      <p>${detail}</p>
      <p style="margin-top:12px">回到 Mini App 页面确认写入配置即可关闭此标签。</p>
    </main>
  </body>
</html>`;
}
