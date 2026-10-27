// @ts-check

/**
 * MCP OAuth domain service.
 *
 * This module owns every state mutation of the board: OAuth metadata discovery,
 * dynamic client registration, the PKCE authorization-code flow, credential
 * storage, and the surgical `mcp.json` patch.
 *
 * Token material never leaves this module. The Client only ever receives
 * metadata about a token (scope, expiry, fingerprint, status), never the token.
 */

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';

import { serviceError } from './errors.mjs';

const CLIENT_NAME = 'MCP OAuth Console';
const CALLBACK_PATH = '/oauth/callback';
/** The name of the Host's data directory. The search for `mcp.json` stops there. */
const MINIMAX_DIR_NAME = '.minimax';
const REFRESH_WINDOW_MS = 30 * 60 * 1000;
/** How long a successful detection stays valid, and how long a failed one is
 *  remembered before a retry is allowed (a flaky network must not pin a wrong
 *  conclusion for ten minutes). */
const DISCOVERY_TTL_MS = 10 * 60 * 1000;
const FAILED_DISCOVERY_TTL_MS = 60 * 1000;
const PROBE_TIMEOUT_MS = 20_000;
/** How many redirect hops a request may take before it is refused. */
const MAX_REDIRECT_HOPS = 5;

/** Short, non-reversible label for a token. Lets the user compare old vs new. */
export function fingerprint(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 8);
}

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Reads `exp` (ms epoch) from a JWT access token, when the token is a JWT. */
export function readTokenExpiry(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (typeof payload.exp === 'number') return payload.exp * 1000;
  } catch {
    return null;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* JSON text helpers - used to patch one field without reformatting   */
/* ------------------------------------------------------------------ */

function skipWhitespace(text, index) {
  let i = index;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  return i;
}

function readJsonString(text, index) {
  if (text[index] !== '"') throw serviceError('config_not_parseable');
  let i = index + 1;
  let value = '';
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      const next = text[i + 1];
      const simple = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
      if (next === 'u') {
        value += String.fromCharCode(Number.parseInt(text.slice(i + 2, i + 6), 16));
        i += 6;
        continue;
      }
      value += simple[next] ?? next;
      i += 2;
      continue;
    }
    if (ch === '"') return { value, end: i + 1 };
    value += ch;
    i += 1;
  }
  throw serviceError('config_not_parseable');
}

function matchObjectSpan(text, start) {
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      i = readJsonString(text, i).end;
      continue;
    }
    if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  throw serviceError('config_not_parseable');
}

function findMemberObjectSpan(text, key, from = 0, to = text.length) {
  const needle = JSON.stringify(key);
  let index = text.indexOf(needle, from);
  while (index !== -1 && index < to) {
    let i = skipWhitespace(text, index + needle.length);
    if (text[i] === ':') {
      i = skipWhitespace(text, i + 1);
      if (text[i] === '{') {
        const end = matchObjectSpan(text, i);
        return { start: i, end };
      }
    }
    index = text.indexOf(needle, index + 1);
  }
  return null;
}

function findRootObjectSpan(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  return { start, end: matchObjectSpan(text, start) };
}

function findMemberStringSpan(text, key, from, to) {
  const needle = JSON.stringify(key);
  let index = text.indexOf(needle, from);
  while (index !== -1 && index < to) {
    let i = skipWhitespace(text, index + needle.length);
    if (text[i] === ':') {
      i = skipWhitespace(text, i + 1);
      if (text[i] === '"') {
        const parsed = readJsonString(text, i);
        return { start: i, end: parsed.end, value: parsed.value };
      }
    }
    index = text.indexOf(needle, index + 1);
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Configuration + credential files                                    */
/* ------------------------------------------------------------------ */

/**
 * Locates the runtime `mcp.json`.
 *
 * Only two sources are used: the Host's own data-dir chain (the plugin data
 * dir lives inside the MiniMax data dir) and the documented default location.
 * The process working directory and the Node executable's directory are
 * deliberately not searched, so an unrelated `mcp.json` there can never win.
 *
 * The search stops at the MiniMax data directory: the Host's configuration
 * lives there, and an `mcp.json` one level above it belongs to something
 * else. The user's home directory is the outer bound for the same reason.
 *
 * The result is a candidate only. Before anything is written it is realpath'ed
 * and shown in the page, and the write is bound to that exact path.
 */
export function resolveMcpConfigPath(dataDir) {
  const home = homedir();
  let dir = resolve(dataDir);
  for (let depth = 0; depth < 10; depth += 1) {
    const candidate = join(dir, 'mcp.json');
    if (existsSync(candidate)) return candidate;
    // The MiniMax data directory is the boundary of the search.
    if (basename(dir) === MINIMAX_DIR_NAME) break;
    const parent = dirname(dir);
    if (parent === dir || parent === home) break;
    dir = parent;
  }
  return join(home, MINIMAX_DIR_NAME, 'mcp.json');
}

/** The canonical path of the configuration file, with symlinks resolved. */
export async function canonicalConfigPath(path) {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

/**
 * A server name becomes a file name, so it is restricted to a safe set. A
 * name such as `../../other` must never be able to leave the credential
 * directory.
 */
export function assertServerName(serverName) {
  if (
    typeof serverName !== 'string' ||
    !/^[A-Za-z0-9._-]{1,64}$/.test(serverName) ||
    serverName === '.' ||
    serverName === '..'
  ) {
    throw serviceError('invalid_server_name');
  }
  return serverName;
}

/** The credential path for a server, proven to stay inside its directory. */
export function credentialPath(serverName, dir) {
  assertServerName(serverName);
  const base = resolve(dir);
  const path = resolve(join(base, `${serverName}.json`));
  if (!path.startsWith(base + sep)) throw serviceError('invalid_server_name');
  return path;
}

async function readConfigFile(path) {
  const text = await readFile(path, 'utf8');
  const config = JSON.parse(text);
  const servers = config && typeof config.mcpServers === 'object' && config.mcpServers ? config.mcpServers : {};
  return { text, config, servers };
}

async function writeJsonFile(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function backupConfig(path, backupPath) {
  // A failed backup must abort the write: the backup is the only way back.
  const text = await readFile(path, 'utf8');
  await mkdir(dirname(backupPath), { recursive: true });
  await writeFileAtomic(backupPath, text);
  return true;
}

/**
 * Writes a file atomically: a temp file in the same directory, then a rename.
 * The original file mode is carried over, because the temp file starts with
 * the default mode and the file being replaced may be restricted.
 */
async function writeFileAtomic(path, text) {
  const dir = dirname(path);
  const temp = join(dir, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  const mode = await stat(path).then((info) => info.mode).catch(() => undefined);
  try {
    await writeFile(temp, text, 'utf8');
    if (mode !== undefined) await chmod(temp, mode).catch(() => undefined);
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* OAuth protocol helpers                                              */
/* ------------------------------------------------------------------ */

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Resolves a redirect target and checks it with the same rule as the URL the
 * request started from.
 */
export function resolveRedirectTarget(current, location, guard) {
  let next;
  try {
    next = new URL(location, current).toString();
  } catch {
    throw serviceError('redirect_invalid');
  }
  if (guard) guard(next);
  return next;
}

/**
 * Headers that must never travel to a host that did not receive them.
 */
const CREDENTIAL_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];

/** Returns the header set without the credential headers. */
function withoutCredentialHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!CREDENTIAL_HEADERS.includes(name.toLowerCase())) out[name] = value;
  }
  return out;
}

/**
 * Follows a redirect by hand and checks every hop again.
 *
 * `fetch` follows a redirect on its own, which would let a hostile server
 * answer with a `302` pointing at the network around this machine and walk
 * right past the URL guard. Each hop is therefore validated with the same
 * rule as the first URL.
 *
 * A redirect must also not carry the credential to a host that did not
 * receive it: `fetch` drops the `Authorization` header on a cross-origin
 * redirect, and the manual loop has to do the same. A request whose *body*
 * holds a secret - a token request, a client registration, a device code -
 * is not followed at all: those endpoints are not expected to redirect.
 */
async function fetchGuarded(url, init, signal, guard, sensitive = false) {
  if (guard) guard(url);
  let current = url;
  let currentInit = { ...init, redirect: 'manual' };
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
    const response = await fetch(current, { ...currentInit, signal });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get('location');
    try {
      await response.body?.cancel();
    } catch {
      // the body was already closed
    }
    if (!location) return response;
    if (sensitive) throw serviceError('redirect_not_allowed');
    if (hop === MAX_REDIRECT_HOPS) throw serviceError('too_many_redirects');
    const next = resolveRedirectTarget(current, location, guard);
    // A redirect to another origin must not carry the credential along.
    if (currentInit.headers && new URL(next).origin !== new URL(current).origin) {
      currentInit = { ...currentInit, headers: withoutCredentialHeaders(currentInit.headers) };
    }
    // 301, 302 and 303 turn a POST into a GET without a body, like a browser.
    if (
      String(currentInit.method ?? 'GET').toUpperCase() === 'POST' &&
      (response.status === 301 || response.status === 302 || response.status === 303)
    ) {
      currentInit = { ...currentInit, method: 'GET' };
      delete currentInit.body;
    }
    current = next;
  }
  throw serviceError('too_many_redirects');
}

/**
 * HTTP helper with retry. The built-in fetch fails with a 10s connect timeout
 * on this network's proxied first connection, so transient connect failures are
 * retried instead of being reported as an empty or failed probe.
 *
 * `guard` is called for the first URL and for every redirect hop, so no
 * request can leave the network the caller allowed. `sensitive` marks a
 * request whose body holds a credential: it is never redirected.
 */
async function httpJson(url, init, options = {}) {
  const {
    timeoutMs = PROBE_TIMEOUT_MS,
    attempts = 3,
    headersOnly = false,
    guard = null,
    sensitive = false,
  } = options;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchGuarded(url, init, controller.signal, guard, sensitive);
      if (headersOnly) {
        // The body of an SSE stream never ends, so it must not be read.
        try {
          await response.body?.cancel();
        } catch {
          // the stream was already closed
        }
        return { status: response.status, ok: response.ok, headers: response.headers, text: '', json: null };
      }
      const text = await response.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { status: response.status, ok: response.ok, headers: response.headers, text, json };
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await delay(500 * attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('request_failed');
}

/**
 * Exported for the package tests: one request that checks the first URL and
 * every redirect hop with the given guard.
 */
export async function guardedRequest(url, init, options = {}) {
  return httpJson(url, init, { attempts: 1, ...options });
}

/**
 * The MCP request used to test an endpoint: a real `initialize` handshake.
 * A plain GET is not a valid MCP call, and servers answer it with 405 before
 * any auth check, which would make an OAuth-protected endpoint look open.
 */
function buildInitializeRequest(token) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: CLIENT_NAME, version: '1.0.0' },
      },
    }),
  };
}

/**
 * The request used to test an endpoint. It must match the declared transport:
 *  - streamable-http: a real `initialize` JSON-RPC call;
 *  - sse: a GET that opens the event stream. A POST to the /sse URL is not a
 *    valid call for that transport and answers 405.
 */
function probeRequest(url, { transport, token }) {
  if (transport === 'sse') {
    const headers = { accept: 'text/event-stream' };
    if (token) headers.authorization = `Bearer ${token}`;
    return { method: 'GET', headers };
  }
  return buildInitializeRequest(token);
}

/** True for loopback, private, link-local, unique-local and metadata addresses. */
export function isPrivateHost(hostname) {
  const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '::') return true;
  if (host === '169.254.169.254' || host === 'metadata.google.internal' || host.endsWith('.internal')) return true;

  // IPv4, in any of the textual forms a URL may carry.
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const parts = ipv4.slice(1).map(Number);
    if (parts.some((part) => part > 255)) return true;
    const [a, b] = parts;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }

  if (host.includes(':')) return isPrivateIpv6(host);
  return false;
}

/**
 * Splits an IPv6 address into its eight groups. Both the dotted form
 * (`::ffff:127.0.0.1`) and the hex form WHATWG URLs produce
 * (`::ffff:7f00:1`) are accepted, because a URL parser rewrites the first one
 * before the guard ever sees it.
 */
function parseIpv6Groups(text) {
  if (!text) return [];
  const groups = [];
  for (const part of text.split(':')) {
    if (part.includes('.')) {
      const bytes = part.split('.');
      if (bytes.length !== 4) return null;
      const numbers = bytes.map((byte) => (/^\d{1,3}$/.test(byte) ? Number(byte) : NaN));
      if (numbers.some((number) => !Number.isInteger(number) || number > 255)) return null;
      groups.push((numbers[0] << 8) | numbers[1], (numbers[2] << 8) | numbers[3]);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    groups.push(parseInt(part, 16));
  }
  return groups;
}

/** Expands an IPv6 address into its eight 16 bit groups, or null if malformed. */
function expandIpv6(host) {
  const halves = host.split('::');
  if (halves.length > 2) return null;
  const head = parseIpv6Groups(halves[0]);
  const tail = halves.length === 2 ? parseIpv6Groups(halves[1]) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  return [...head, ...new Array(missing).fill(0), ...tail];
}

/**
 * Classifies an IPv6 address. Besides the reserved ranges it resolves the
 * forms that carry an IPv4 address inside IPv6, because those are the way to
 * smuggle a loopback or private target past a naive prefix check.
 */
function isPrivateIpv6(host) {
  const groups = expandIpv6(host);
  // An address we cannot parse is not one we may reach.
  if (!groups) return true;

  const isZero = groups.every((group) => group === 0);
  if (isZero) return true;
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true;

  const embeddedIpv4 = (high, low) => `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  const zeroPrefix = groups.slice(0, 5).every((group) => group === 0);
  if (zeroPrefix && groups[5] === 0xffff) {
    // IPv4-mapped: ::ffff:127.0.0.1
    return isPrivateHost(embeddedIpv4(groups[6], groups[7]));
  }
  if (groups.slice(0, 6).every((group) => group === 0) && (groups[6] !== 0 || groups[7] !== 0)) {
    // IPv4-compatible: ::127.0.0.1
    return isPrivateHost(embeddedIpv4(groups[6], groups[7]));
  }
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((group) => group === 0)) {
    // NAT64: 64:ff9b::127.0.0.1
    return isPrivateHost(embeddedIpv4(groups[6], groups[7]));
  }
  if ((groups[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((groups[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if ((groups[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

/**
 * Validates a target before the process makes a request to it. The page is
 * untrusted input to the Node process, so a typed URL must not turn this Mini
 * App into an open proxy.
 *
 * `allowPrivateNetwork` is only for the MCP endpoint the user configured
 * themselves; every URL that comes back from a remote server is checked
 * strictly, because a hostile server could otherwise point us at the network
 * around this machine.
 */
export function assertTargetUrl(url, options = {}) {
  const { allowPrivateNetwork = false } = options;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw serviceError('target_url_invalid');
  }
  if (parsed.username || parsed.password) throw serviceError('target_url_contains_credentials');
  const host = parsed.hostname.toLowerCase();
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw serviceError('target_url_invalid');
  }
  if (isPrivateHost(host)) {
    // A private address is acceptable only when the user pointed us at it.
    if (!allowPrivateNetwork) throw serviceError('target_url_blocked');
  }
  return parsed;
}

/** Strict check for every URL that a remote server handed us. */
export function assertMetadataUrl(url) {
  const parsed = assertTargetUrl(url, { allowPrivateNetwork: false });
  if (parsed.protocol !== 'https:') throw serviceError('target_url_invalid');
  return parsed;
}

/** The hop guard for a URL that a remote server handed us. */
const strictHop = (url) => {
  assertMetadataUrl(url);
};

/** The hop guard for the MCP endpoint the user configured themselves. */
const endpointHop = (allowPrivateNetwork) => (url) => {
  assertTargetUrl(url, { allowPrivateNetwork });
};

/**
 * Detects what an MCP endpoint demands and resolves the authorization server
 * metadata via the RFC 9728 protected-resource document.
 *
 * A 401 alone does NOT mean OAuth: the server may want an API key or another
 * scheme. Only a `WWW-Authenticate: Bearer resource_metadata="..."` challenge
 * is treated as a declaration of OAuth.
 */
export async function discoverAuthorization(url, options = {}) {
  const transport = options.transport === 'sse' ? 'sse' : 'streamable-http';
  // The endpoint itself is the one the user configured, so a private address
  // is allowed only when they opted into that.
  assertTargetUrl(url, { allowPrivateNetwork: options.allowPrivateNetwork === true });
  const probe = await httpJson(
    url,
    probeRequest(url, { transport }),
    { timeoutMs: PROBE_TIMEOUT_MS, attempts: 3, headersOnly: transport === 'sse', guard: endpointHop(options.allowPrivateNetwork === true) },
  );
  if (probe.status !== 401) {
    // Only a 2xx proves the endpoint accepted an unauthenticated handshake.
    // 404 / 405 / 5xx say nothing about whether auth is required.
    if (probe.status >= 200 && probe.status < 300) {
      return { oauthProtected: false, authRequirement: 'none', status: probe.status, metadata: null, authorizationServer: null };
    }
    return {
      oauthProtected: null,
      authRequirement: 'unknown',
      status: probe.status,
      metadata: null,
      authorizationServer: null,
      reason: 'probe_indeterminate',
    };
  }
  const challenge = probe.headers.get('www-authenticate') || '';
  const resourceMatch = /resource_metadata="([^"]+)"/i.exec(challenge);
  if (!resourceMatch) {
    // No OAuth challenge: the endpoint rejected us, but it never said which
    // scheme it wants. Claiming "OAuth" here would be an over-assertion.
    const bearer = /^bearer/i.test(challenge.trim());
    return {
      oauthProtected: false,
      authRequirement: bearer ? 'bearer' : 'credential',
      status: 401,
      metadata: null,
      authorizationServer: null,
      reason: bearer ? 'bearer_without_resource_metadata' : 'credential_required_unknown_scheme',
    };
  }
  const resourceDoc = await httpJson(
    assertMetadataUrl(resourceMatch[1]).toString(),
    { headers: { accept: 'application/json' } },
    { guard: strictHop },
  );
  const issuers = Array.isArray(resourceDoc.json?.authorization_servers) ? resourceDoc.json.authorization_servers : [];
  const metadata = await loadAuthorizationServerMetadata(issuers);
  return {
    oauthProtected: true,
    authRequirement: 'oauth',
    status: 401,
    metadata,
    authorizationServer: metadata?.issuer ?? issuers[0] ?? null,
    scopes: metadata?.scopes_supported ?? [],
    resource: resourceDoc.json?.resource ?? null,
  };
}

async function loadAuthorizationServerMetadata(issuers) {
  for (const issuer of issuers) {
    const base = String(issuer).replace(/\/+$/, '');
    for (const candidate of [`${base}/.well-known/oauth-authorization-server`, `${base}/.well-known/openid-configuration`]) {
      try {
        // Every URL a remote server handed us is checked strictly: a hostile
        // server must not be able to point us at the network around this host.
        assertMetadataUrl(candidate);
        const response = await httpJson(
          candidate,
          { headers: { accept: 'application/json' } },
          { guard: strictHop },
        );
        if (response.ok && response.json?.token_endpoint) return response.json;
      } catch {
        // try the next well-known location
      }
    }
  }
  return null;
}

function pickAuthMethod(metadata) {
  const supported = Array.isArray(metadata?.token_endpoint_auth_methods_supported)
    ? metadata.token_endpoint_auth_methods_supported
    : [];
  if (supported.includes('client_secret_basic')) return 'client_secret_basic';
  if (supported.includes('client_secret_post')) return 'client_secret_post';
  return 'client_secret_post';
}

async function registerClient(metadata, { redirectUri, scope, grantTypes }) {
  const endpoint = metadata?.registration_endpoint;
  if (!endpoint) throw serviceError('dynamic_registration_unsupported');
  assertMetadataUrl(endpoint);
  const supported = Array.isArray(metadata.grant_types_supported) ? metadata.grant_types_supported : [];
  const requested = grantTypes ?? (() => {
    const list = ['authorization_code'];
    if (supported.includes('refresh_token') || supported.length === 0) list.push('refresh_token');
    return list;
  })();
  const body = {
    client_name: CLIENT_NAME,
    redirect_uris: [redirectUri],
    grant_types: requested,
    response_types: ['code'],
    token_endpoint_auth_method: pickAuthMethod(metadata),
  };
  if (scope) body.scope = scope;
  const response = await httpJson(
    endpoint,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    },
    // The body carries the client secret, so this request is never redirected.
    { guard: strictHop, sensitive: true },
  );
  if (!response.ok || !response.json?.client_id) {
    throw serviceError(`dynamic_registration_failed_${response.status}`);
  }
  return response.json;
}

function buildAuthorizeUrl(metadata, { clientId, redirectUri, state, codeChallenge, scope }) {
  const endpoint = metadata?.authorization_endpoint;
  if (!endpoint) throw serviceError('authorization_endpoint_missing');
  // The browser is about to be sent here, so the address is checked as well:
  // a hostile server must not be able to point the consent page at the
  // network around this machine.
  assertMetadataUrl(endpoint);
  const url = new URL(endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (scope) url.searchParams.set('scope', scope);
  return url.toString();
}

function tokenRequestBody({ grantType, code, codeVerifier, redirectUri, refreshToken, clientId, clientSecret, authMethod }) {
  const form = new URLSearchParams();
  form.set('grant_type', grantType);
  if (code) form.set('code', code);
  if (codeVerifier) form.set('code_verifier', codeVerifier);
  if (redirectUri) form.set('redirect_uri', redirectUri);
  if (refreshToken) form.set('refresh_token', refreshToken);
  if (clientId) form.set('client_id', clientId);
  if (clientSecret && authMethod === 'client_secret_post') form.set('client_secret', clientSecret);
  return form;
}

async function requestToken(metadata, client, form) {
  assertMetadataUrl(metadata.token_endpoint);
  const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  if (client.client_secret && client.auth_method === 'client_secret_basic') {
    headers.authorization = `Basic ${Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64')}`;
  }
  const response = await httpJson(
    metadata.token_endpoint,
    {
      method: 'POST',
      headers,
      body: form.toString(),
    },
    // The body carries the refresh token, the client secret or the code.
    { guard: strictHop, sensitive: true },
  );
  if (!response.ok || !response.json?.access_token) {
    const code = response.json?.error || `http_${response.status}`;
    throw serviceError(`token_request_failed_${code}`);
  }
  return response.json;
}

/**
 * Verifies a token against the MCP endpoint with a handshake that matches the
 * declared transport.
 */
export async function probeMcpEndpoint(url, token, transport, options = {}) {
  const isSse = transport === 'sse';
  try {
    const response = await httpJson(
      url,
      probeRequest(url, { transport, token }),
      { timeoutMs: PROBE_TIMEOUT_MS, attempts: 3, headersOnly: isSse, guard: endpointHop(options.allowPrivateNetwork === true) },
    );
    return { status: response.status, ok: response.status === 200 || response.status === 204 };
  } catch (error) {
    return { status: 0, ok: false, error: error instanceof Error ? error.message : 'probe_failed' };
  }
}

/* ------------------------------------------------------------------ */
/* Service                                                             */
/* ------------------------------------------------------------------ */

export function createOAuthService({ dataDir, baseUrl, logger, onChange }) {
  // Durable state belongs in the Host-owned dataDir. A credential directory
  // left next to mcp.json by an earlier version is read once and imported;
  // it is never written to again.
  const credentialDir = join(dataDir, 'mcp-credentials');
  const settingsPath = join(dataDir, 'settings.json');
  const backupPath = join(dataDir, 'mcp.json.bak');
  const appliedBackupPath = join(dataDir, 'mcp.json.applied.bak');

  // The configuration file is resolved once, symlinks resolved, and the page
  // shows the exact path that a write would touch.
  let configPathPromise = null;
  const getConfigPath = async () => {
    if (!configPathPromise) {
      configPathPromise = canonicalConfigPath(resolveMcpConfigPath(dataDir));
    }
    return configPathPromise;
  };

  let legacyCredentialDir = null;
  const getLegacyCredentialDir = async () => {
    if (!legacyCredentialDir) {
      legacyCredentialDir = join(dirname(await getConfigPath()), 'mcp-credentials');
    }
    return legacyCredentialDir;
  };

  const settings = { autoRefresh: false, allowPrivateNetwork: false };
  let settingsLoaded = false;
  const loadSettings = async () => {
    if (settingsLoaded) return settings;
    settingsLoaded = true;
    try {
      const parsed = JSON.parse(await readFile(settingsPath, 'utf8'));
      if (typeof parsed.autoRefresh === 'boolean') settings.autoRefresh = parsed.autoRefresh;
      if (typeof parsed.allowPrivateNetwork === 'boolean') settings.allowPrivateNetwork = parsed.allowPrivateNetwork;
    } catch {
      // No settings file yet: the defaults apply.
    }
    return settings;
  };
  const saveSettings = async (patch) => {
    await loadSettings();
    for (const [key, value] of Object.entries(patch)) {
      if (typeof value === 'boolean') settings[key] = value;
    }
    await writeJsonFile(settingsPath, settings);
    return settings;
  };

  /** sessionId -> pending authorization state (server side only) */
  const pending = new Map();
  /** serverName -> discovery cache */
  const discoveryCache = new Map();
  /** serverName -> pending grant awaiting user confirmation */
  const awaitingConfirmation = new Map();
  /** serverName -> device authorization session (RFC 8628) */
  const deviceSessions = new Map();

  const children = new Set();

  function log(level, message) {
    // Only the keys of `fields` leave the process, so diagnostics belong in
    // the message itself.
    logger[level](message);
  }

  /** Serializes writes to the configuration file so two of them cannot race. */
  let writeChain = Promise.resolve();
  const withWriteLock = (task) => {
    const run = writeChain.then(task, task);
    writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  async function listConfiguredServers() {
    let parsed;
    try {
      parsed = await readConfigFile(await getConfigPath());
    } catch (error) {
      return { servers: [], error: error instanceof Error ? error.message : 'config_unreadable' };
    }
    const servers = Object.entries(parsed.servers).map(([name, entry]) => {
      const headers = entry && typeof entry === 'object' && entry.headers && typeof entry.headers === 'object' ? entry.headers : {};
      const authorization = typeof headers.Authorization === 'string' ? headers.Authorization : '';
      const scheme = authorization ? authorization.split(/\s+/)[0] : '';
      const tokenPart = scheme ? authorization.slice(scheme.length).trim() : '';
      const otherHeaderCount = Object.keys(headers).filter((key) => key !== 'Authorization').length;
      return {
        name,
        type: typeof entry?.type === 'string' ? entry.type : '',
        url: typeof entry?.url === 'string' ? entry.url : '',
        enabled: entry?.enabled !== false,
        hasAuthorization: Boolean(authorization),
        authorizationScheme: scheme,
        otherHeaderCount,
        // Fingerprint only: the page never sees the credential itself.
        authorizationFingerprint: tokenPart ? fingerprint(tokenPart) : null,
      };
    });
    return { servers, error: null };
  }

  async function loadCredential(serverName) {
    const own = credentialPath(serverName, credentialDir);
    if (existsSync(own)) {
      try {
        return JSON.parse(await readFile(own, 'utf8'));
      } catch {
        return null;
      }
    }
    // One-time import from the legacy directory: read-only, and the copy that
    // lands in dataDir becomes the only copy this app maintains.
    const legacy = credentialPath(serverName, await getLegacyCredentialDir());
    if (!existsSync(legacy)) return null;
    try {
      const data = JSON.parse(await readFile(legacy, 'utf8'));
      await saveCredential(serverName, data);
      log('info', `oauth.credential_imported server=${serverName}`);
      return data;
    } catch {
      return null;
    }
  }

  async function saveCredential(serverName, data) {
    const path = credentialPath(serverName, credentialDir);
    await writeJsonFile(path, data);
    return path;
  }

  async function probeDiscovery(serverName, url, transport) {
    const cached = discoveryCache.get(serverName);
    if (cached && Date.now() - cached.at < cached.ttlMs) return cached.value;
    const { allowPrivateNetwork } = await loadSettings();
    try {
      const value = await discoverAuthorization(url, { transport, allowPrivateNetwork });
      discoveryCache.set(serverName, { at: Date.now(), ttlMs: DISCOVERY_TTL_MS, value });
      return value;
    } catch (error) {
      // A failed probe means "unknown", not "no OAuth required". Reporting it as
      // `oauthProtected: false` would tell the page the endpoint is open.
      const value = {
        oauthProtected: null,
        authRequirement: 'unknown',
        status: 0,
        metadata: null,
        authorizationServer: null,
        scopes: [],
        reason: 'probe_failed',
        error: error instanceof Error ? error.message : 'probe_failed',
      };
      discoveryCache.set(serverName, { at: Date.now(), ttlMs: FAILED_DISCOVERY_TTL_MS, value });
      return value;
    }
  }

  /** Public, credential-free snapshot for the Client. */
  async function buildState() {
    const { servers, error: configError } = await listConfiguredServers();
    const items = [];
    for (const server of servers) {
      const credential = await loadCredential(server.name);
      const cachedDiscovery = discoveryCache.get(server.name);
      const expiresAt =
        credential?.access_token
          ? readTokenExpiry(credential.access_token) ??
            (credential.obtained_at && credential.expires_in
              ? Date.parse(credential.obtained_at) + Number(credential.expires_in) * 1000
              : null)
          : null;
      const grant = awaitingConfirmation.get(server.name);
      const credentialFingerprint = credential?.access_token ? fingerprint(credential.access_token) : null;
      const configFingerprint = server.authorizationFingerprint;

      // Two orthogonal facts, kept apart on purpose:
      //   * what the SERVER requires  -> oauthProtected / authorizationServer
      //   * what THIS MACHINE holds  -> credentialState
      // A server can require OAuth and still be satisfied by a local token, and
      // a machine can hold a token that the configuration does not actually use.
      const warnings = [];
      if (credential?.access_token && !server.hasAuthorization) {
        warnings.push('凭据文件里有令牌，但 mcp.json 中未配置 Authorization，实际不会生效');
      }
      if (server.hasAuthorization && credentialFingerprint && configFingerprint && credentialFingerprint !== configFingerprint) {
        warnings.push('mcp.json 中的令牌与凭据文件不一致，续期后两者会同步');
      }
      if (credential?.refresh_token && !credential?.client_id) {
        warnings.push('凭据缺少 client_id，无法自动续期');
      }

      let credentialState;
      if (grant) credentialState = 'pending';
      else if (!server.hasAuthorization) {
        credentialState = server.otherHeaderCount > 0 ? 'other_scheme' : 'not_configured';
      } else if (Number.isFinite(expiresAt)) {
        credentialState = expiresAt - Date.now() <= 0 ? 'expired' : expiresAt - Date.now() < REFRESH_WINDOW_MS ? 'expiring' : 'valid';
      } else credentialState = 'configured_unknown';

      items.push({
        name: server.name,
        type: server.type,
        url: server.url,
        enabled: server.enabled,
        hasAuthorization: server.hasAuthorization,
        authorizationScheme: server.authorizationScheme,
        oauthProtected: cachedDiscovery?.value?.oauthProtected ?? null,
        authRequirement: cachedDiscovery?.value?.authRequirement ?? 'unknown',
        authorizationServer: cachedDiscovery?.value?.authorizationServer ?? null,
        supportedScopes: cachedDiscovery?.value?.scopes ?? [],
        dynamicRegistration: Boolean(cachedDiscovery?.value?.metadata?.registration_endpoint),
        oauthReason: cachedDiscovery?.value?.reason ?? null,
        scope: credential?.scope ?? null,
        expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
        obtainedAt: credential?.obtained_at ?? null,
        remainingMs: Number.isFinite(expiresAt) ? expiresAt - Date.now() : null,
        refreshable: Boolean(credential?.refresh_token && credential?.client_id),
        credentialState,
        configFingerprint,
        tokenFingerprint: credentialFingerprint,
        warnings,
        pendingGrant: Boolean(grant),
        pendingFingerprint: grant ? fingerprint(grant.token.access_token) : null,
        pendingConfirmToken: grant?.confirmToken ?? null,
        lastError: grant?.error ?? null,
      });
    }
    const now = Date.now();
    return {
      now,
      configError,
      configPath: await getConfigPath(),
      settings: await loadSettings(),
      servers: items,
      summary: {
        total: items.length,
        authorized: items.filter((item) => item.hasAuthorization).length,
        refreshable: items.filter((item) => item.refreshable).length,
        expiringSoon: items.filter((item) => Number.isFinite(item.remainingMs) && item.remainingMs > 0 && item.remainingMs < REFRESH_WINDOW_MS).length,
      },
    };
  }

  /**
   * Opens a URL in the default browser. The platform helper differs, and on
   * Linux `open` does not exist at all, so a failed spawn is reported instead
   * of being swallowed - the page then tells the user to copy the link.
   */
  async function openInBrowser(url) {
    const command =
      process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    try {
      // Arguments are passed as an argv array and never through a shell.
      const child = spawn(command, [url], { stdio: 'ignore' });
      children.add(child);
      child.once('exit', () => children.delete(child));
      const started = await new Promise((resolve) => {
        let settled = false;
        const done = (value) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        child.once('spawn', () => done(true));
        child.once('error', () => done(false));
      });
      child.unref();
      return started;
    } catch {
      return false;
    }
  }

  async function startAuthorization({ serverName, url, scope }) {
    const { servers } = await listConfiguredServers();
    const existing = servers.find((item) => item.name === serverName);
    const targetUrl = existing?.url || url;
    if (!targetUrl) throw serviceError('target_url_required');
    // The endpoint is the one the user configured, so a private address is
    // allowed when they opted into that. The URLs the server hands back are
    // checked strictly later on.
    const { allowPrivateNetwork } = await loadSettings();
    assertTargetUrl(targetUrl, { allowPrivateNetwork });

    const transport = existing?.type === 'sse' ? 'sse' : 'streamable-http';
    const discovery = await probeDiscovery(serverName, targetUrl, transport);
    if (discovery.authRequirement !== 'oauth' || !discovery.metadata) {
      // The endpoint never declared OAuth, so there is no authorization server
      // to run a browser flow against. Say exactly what it wants instead.
      if (discovery.reason === 'bearer_without_resource_metadata') throw serviceError('bearer_without_resource_metadata');
      if (discovery.reason === 'credential_required_unknown_scheme') throw serviceError('credential_required_unknown_scheme');
      throw serviceError('authorization_server_not_resolved');
    }

    const metadata = discovery.metadata;
    const redirectUri = `${baseUrl}${CALLBACK_PATH}`;
    const client = await registerClient(metadata, { redirectUri, scope });
    const codeVerifier = base64url(randomBytes(32));
    const codeChallenge = base64url(createHash('sha256').update(codeVerifier).digest());
    const state = randomBytes(16).toString('hex');
    const sessionId = randomBytes(12).toString('hex');

    const resolvedScope = scope || discovery.scopes?.[0] || undefined;
    const authorizationUrl = buildAuthorizeUrl(metadata, {
      clientId: client.client_id,
      redirectUri,
      state,
      codeChallenge,
      scope: resolvedScope,
    });

    pending.set(sessionId, {
      sessionId,
      serverName,
      url: targetUrl,
      metadata,
      client: {
        client_id: client.client_id,
        client_secret: client.client_secret ?? null,
        auth_method: client.token_endpoint_auth_method ?? pickAuthMethod(metadata),
      },
      codeVerifier,
      redirectUri,
      state,
      scope: resolvedScope ?? null,
      createdAt: Date.now(),
    });

    const opened = await openInBrowser(authorizationUrl);
    log('info', `oauth.authorization_started server=${serverName} browser_opened=${opened}`);
    return {
      sessionId,
      authorizationUrl,
      redirectUri,
      scope: resolvedScope ?? null,
      authorizationServer: metadata.issuer ?? null,
      browserOpened: opened,
    };
  }

  async function completeAuthorization({ sessionId, redirectUrl }) {
    const session = pending.get(sessionId);
    if (!session) throw serviceError('session_not_found');
    let code = null;
    let state = null;
    if (redirectUrl) {
      const url = new URL(redirectUrl);
      code = url.searchParams.get('code');
      state = url.searchParams.get('state');
      const error = url.searchParams.get('error');
      if (error) throw serviceError(`authorization_denied_${error}`);
    }
    if (!code) throw serviceError('authorization_code_missing');
    // The state must match exactly: a pasted URL without one is not a
    // callback for this session.
    if (state !== session.state) throw serviceError('state_mismatch');

    const form = tokenRequestBody({
      grantType: 'authorization_code',
      code,
      codeVerifier: session.codeVerifier,
      redirectUri: session.redirectUri,
      clientId: session.client.client_id,
      clientSecret: session.client.client_secret,
      authMethod: session.client.auth_method,
    });
    const token = await requestToken(session.metadata, session.client, form);
    pending.delete(sessionId);

    const grant = {
      serverName: session.serverName,
      url: session.url,
      token,
      client: session.client,
      scope: session.scope,
      createdAt: Date.now(),
      // A one-time token, so a write to the Host configuration always goes
      // through the confirmation the page showed.
      confirmToken: randomBytes(16).toString('hex'),
    };
    awaitingConfirmation.set(session.serverName, grant);
    log('info', `oauth.authorization_completed server=${session.serverName}`);
    return {
      serverName: session.serverName,
      fingerprint: fingerprint(token.access_token),
      scope: token.scope ?? session.scope ?? null,
      expiresIn: token.expires_in ?? null,
      hasRefreshToken: Boolean(token.refresh_token),
    };
  }

  /** Handles the browser redirect. The token stays in Node memory. */
  async function handleCallback(query) {
    const state = query.get('state');
    const error = query.get('error');
    let session = null;
    for (const candidate of pending.values()) {
      if (candidate.state === state) {
        session = candidate;
        break;
      }
    }
    if (!session) {
      return { ok: false, message: '未找到对应的授权会话，请回到 Mini App 重新发起授权。' };
    }
    if (error) {
      pending.delete(session.sessionId);
      return { ok: false, message: `授权被拒绝：${error}` };
    }
    const code = query.get('code');
    if (!code) return { ok: false, message: '回调缺少 authorization code。' };
    try {
      const form = tokenRequestBody({
        grantType: 'authorization_code',
        code,
        codeVerifier: session.codeVerifier,
        redirectUri: session.redirectUri,
        clientId: session.client.client_id,
        clientSecret: session.client.client_secret,
        authMethod: session.client.auth_method,
      });
      const token = await requestToken(session.metadata, session.client, form);
      pending.delete(session.sessionId);
      awaitingConfirmation.set(session.serverName, {
        serverName: session.serverName,
        url: session.url,
        token,
        client: session.client,
        scope: session.scope,
        createdAt: Date.now(),
        confirmToken: randomBytes(16).toString('hex'),
      });
      log('info', `oauth.callback_received server=${session.serverName}`);
      return { ok: true, serverName: session.serverName, message: '授权成功，请回到 Mini App 确认写入配置。' };
    } catch (tokenError) {
      pending.delete(session.sessionId);
      const message = tokenError instanceof Error ? tokenError.message : 'token_exchange_failed';
      log('warn', `oauth.callback_failed server=${session.serverName} reason=${message}`);
      return { ok: false, message: `换取令牌失败：${message}` };
    }
  }

  /** Commits a pending grant: credential file first, then the mcp.json patch. */
  async function applyGrant(serverName, options = {}) {
    const { confirmToken = null, expectedPath = null } = options;
    const grant = awaitingConfirmation.get(serverName);
    if (!grant) throw serviceError('no_pending_grant');
    // A write to the Host configuration only happens through the confirmation
    // the page showed, so the page has to present the one-time token.
    if (!confirmToken || confirmToken !== grant.confirmToken) throw serviceError('confirm_required');
    const token = grant.token;
    const expiresAt = readTokenExpiry(token.access_token);
    const credential = {
      server: serverName,
      url: grant.url,
      access_token: token.access_token,
      refresh_token: token.refresh_token ?? null,
      token_type: token.token_type ?? 'Bearer',
      scope: token.scope ?? grant.scope ?? null,
      expires_in: token.expires_in ?? null,
      client_id: grant.client.client_id,
      client_secret: grant.client.client_secret,
      obtained_at: new Date().toISOString(),
      note: 'Managed by MCP OAuth Console',
    };
    await saveCredential(serverName, credential);
    const patch = await patchMcpAuthorization(serverName, token.access_token, {
      url: grant.url,
      confirmed: true,
      expectedPath,
    });
    awaitingConfirmation.delete(serverName);
    const { servers: configured } = await listConfiguredServers();
    const transport = configured.find((item) => item.name === serverName)?.type;
    const { allowPrivateNetwork } = await loadSettings();
    const probe = grant.url ? await probeMcpEndpoint(grant.url, token.access_token, transport, { allowPrivateNetwork }) : null;
    log('info', `oauth.grant_applied server=${serverName} probe=${probe?.status ?? 'n/a'}`);
    return {
      serverName,
      fingerprint: fingerprint(token.access_token),
      expiresAt,
      created: patch.created,
      replaced: patch.replaced,
      previousFingerprint: patch.previousFingerprint,
      probe,
    };
  }

  /** Refreshes an existing token with the stored refresh token. */
  async function refreshServer(serverName) {
    const credential = await loadCredential(serverName);
    if (!credential?.refresh_token || !credential?.client_id) throw serviceError('refresh_token_unavailable');
    const { servers } = await listConfiguredServers();
    const server = servers.find((item) => item.name === serverName);
    const url = server?.url || credential.url;
    if (!url) throw serviceError('target_url_missing');

    const discovery = await probeDiscovery(serverName, url, server?.type);
    const metadata = discovery.metadata ?? (await loadAuthorizationServerMetadata([credential.url ?? '']));
    if (!metadata?.token_endpoint) throw serviceError('token_endpoint_unresolved');

    const client = {
      client_id: credential.client_id,
      client_secret: credential.client_secret ?? null,
      auth_method: 'client_secret_basic',
    };
    let form = tokenRequestBody({
      grantType: 'refresh_token',
      refreshToken: credential.refresh_token,
      clientId: client.client_id,
      clientSecret: client.client_secret,
      authMethod: client.auth_method,
    });
    let token;
    try {
      token = await requestToken(metadata, client, form);
    } catch (error) {
      form = tokenRequestBody({
        grantType: 'refresh_token',
        refreshToken: credential.refresh_token,
        clientId: client.client_id,
        clientSecret: client.client_secret,
        authMethod: 'client_secret_post',
      });
      client.auth_method = 'client_secret_post';
      token = await requestToken(metadata, client, form);
    }

    const next = {
      ...credential,
      access_token: token.access_token,
      refresh_token: token.refresh_token ?? credential.refresh_token,
      token_type: token.token_type ?? 'Bearer',
      scope: token.scope ?? credential.scope,
      expires_in: token.expires_in ?? null,
      obtained_at: new Date().toISOString(),
    };
    await saveCredential(serverName, next);
    const patch = await patchMcpAuthorization(serverName, token.access_token, { url });
    const { allowPrivateNetwork } = await loadSettings();
    const probe = await probeMcpEndpoint(url, token.access_token, server?.type, { allowPrivateNetwork });
    log('info', `oauth.token_refreshed server=${serverName} probe=${probe.status}`);
    return {
      serverName,
      fingerprint: fingerprint(token.access_token),
      expiresAt: readTokenExpiry(token.access_token),
      replaced: patch.replaced,
      previousFingerprint: patch.previousFingerprint,
      probe,
    };
  }

  /**
   * Patches `mcpServers.<name>.headers.Authorization` in place, keeping the
   * rest of the file byte-identical. Creates the entry when it is missing.
   *
   * The whole read-modify-write runs under one lock and the file is re-read
   * inside it, so a concurrent edit cannot lose entries. The path the write
   * targets must match the one the user confirmed.
   */
  async function patchMcpAuthorization(serverName, token, options = {}) {
    const { url, confirmed = false, expectedPath = null } = options;
    assertServerName(serverName);
    const bearer = `Bearer ${token}`;

    return withWriteLock(async () => {
      const configPath = await getConfigPath();
      if (expectedPath && resolve(expectedPath) !== resolve(configPath)) {
        throw serviceError('config_path_changed');
      }
      const parsed = await readConfigFile(configPath);
      const rootSpan = findRootObjectSpan(parsed.text);
      if (!rootSpan) throw serviceError('server_entry_not_locatable');
      const serversSpan = findMemberObjectSpan(parsed.text, 'mcpServers', rootSpan.start, rootSpan.end);
      if (!serversSpan) throw serviceError('server_entry_not_locatable');
      const existing = parsed.servers[serverName];

      let nextText;
      let replaced = false;
      let created = false;
      let previous = '';

      if (!existing) {
        // Insert the entry textually, so the rest of the file stays
        // byte-identical instead of being re-serialized.
        const entry = `${JSON.stringify(serverName)}: ${JSON.stringify({
          type: 'streamable-http',
          enabled: true,
          configured: true,
          builtin: false,
          url: url ?? '',
          headers: { Authorization: bearer },
        })}`;
        const insertAt = serversSpan.end - 1;
        const head = parsed.text.slice(0, insertAt).trimEnd();
        const tail = parsed.text.slice(insertAt);
        const separator = head.endsWith('{') ? '' : ',';
        nextText = `${head}${separator}\n    ${entry}\n  ${tail}`;
        created = true;
      } else {
        const span = findMemberObjectSpan(parsed.text, serverName, serversSpan.start, serversSpan.end);
        if (!span) throw serviceError('server_entry_not_locatable');
        const headers = existing.headers && typeof existing.headers === 'object' ? existing.headers : null;
        previous = headers && typeof headers.Authorization === 'string' ? headers.Authorization : '';
        const authSpan = findMemberStringSpan(parsed.text, 'Authorization', span.start, span.end);
        if (authSpan) {
          // Replace the existing Authorization value in place.
          nextText = `${parsed.text.slice(0, authSpan.start)}${JSON.stringify(bearer)}${parsed.text.slice(authSpan.end)}`;
          replaced = true;
        } else {
          // The entry carries no Authorization header yet - it may authenticate
          // with x-api-key, or not at all. Add the header instead of refusing
          // the write after the user already completed the authorization.
          const headersSpan = headers ? findMemberObjectSpan(parsed.text, 'headers', span.start, span.end) : null;
          if (headersSpan) {
            const insertAt = headersSpan.start + 1;
            nextText = `${parsed.text.slice(0, insertAt)}${JSON.stringify('Authorization')}: ${JSON.stringify(bearer)}, ${parsed.text.slice(insertAt)}`;
          } else {
            const insertAt = span.start + 1;
            nextText = `${parsed.text.slice(0, insertAt)}${JSON.stringify('headers')}: { ${JSON.stringify('Authorization')}: ${JSON.stringify(bearer)} }, ${parsed.text.slice(insertAt)}`;
          }
        }
      }

      let verified;
      try {
        verified = JSON.parse(nextText);
      } catch {
        throw serviceError('patched_config_invalid');
      }
      if (verified?.mcpServers?.[serverName]?.headers?.Authorization !== bearer) {
        throw serviceError('patch_verification_failed');
      }
      // The backup is the only way back, so a failed backup aborts the write.
      // A confirmed apply keeps its own copy, so a background refresh cannot
      // replace the state the user was shown.
      await backupConfig(configPath, confirmed ? appliedBackupPath : backupPath);
      await writeFileAtomic(configPath, nextText);
      return {
        created,
        replaced,
        previousFingerprint: previous ? fingerprint(previous.replace(/^\S+\s+/, '')) : null,
      };
    });
  }

  /** Refreshes every server whose token is inside the refresh window. */
  async function refreshExpiring({ force = false } = {}) {
    const { autoRefresh } = await loadSettings();
    if (!autoRefresh && !force) {
      return [];
    }
    const { servers } = await listConfiguredServers();
    const results = [];
    for (const server of servers) {
      const credential = await loadCredential(server.name);
      if (!credential?.refresh_token || !credential?.client_id) continue;
      const expiresAt = readTokenExpiry(credential.access_token);
      if (!Number.isFinite(expiresAt)) continue;
      if (expiresAt - Date.now() > REFRESH_WINDOW_MS) continue;
      try {
        const result = await refreshServer(server.name);
        results.push({ server: server.name, ok: true, expiresAt: result.expiresAt });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'refresh_failed';
        results.push({ server: server.name, ok: false, reason: message });
        log('warn', `oauth.auto_refresh_failed server=${server.name} reason=${message}`);
      }
    }
    return results;
  }

  /**
   * RFC 8628 device authorization. There is no redirect, so the Host's port
   * guard cannot block anything: the user types a short code in the provider's
   * page and the server polls the token endpoint until the grant lands.
   */
  async function startDeviceAuthorization({ serverName, url, scope }) {
    const { servers } = await listConfiguredServers();
    const existing = servers.find((item) => item.name === serverName);
    const targetUrl = existing?.url || url;
    if (!targetUrl) throw serviceError('target_url_required');
    const { allowPrivateNetwork } = await loadSettings();
    assertTargetUrl(targetUrl, { allowPrivateNetwork });
    const transport = existing?.type === 'sse' ? 'sse' : 'streamable-http';
    const discovery = await probeDiscovery(serverName, targetUrl, transport);
    const metadata = discovery.metadata;
    if (!metadata?.device_authorization_endpoint) throw serviceError('device_flow_unsupported');
    // The client must be allowed to use the device grant, or the authorization
    // server rejects the device request.
    const client = await registerClient(metadata, {
      redirectUri: `${baseUrl}${CALLBACK_PATH}`,
      scope,
      grantTypes: [
        'urn:ietf:params:oauth:grant-type:device_code',
        'authorization_code',
        'refresh_token',
      ],
    });
    const form = new URLSearchParams();
    form.set('client_id', client.client_id);
    if (scope) form.set('scope', scope);
    // The device endpoint authenticates the client like the token endpoint:
    // a secret in the body, or a Basic header. Without it the server answers
    // 400 invalid_client.
    const deviceHeaders = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    const authMethod = client.token_endpoint_auth_method ?? pickAuthMethod(metadata);
    if (client.client_secret && authMethod === 'client_secret_post') {
      form.set('client_secret', client.client_secret);
    }
    if (client.client_secret && authMethod === 'client_secret_basic') {
      deviceHeaders.authorization = `Basic ${Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64')}`;
    }
    const response = await httpJson(
      assertMetadataUrl(metadata.device_authorization_endpoint).toString(),
      {
        method: 'POST',
        headers: deviceHeaders,
        body: form.toString(),
      },
      // The body carries the client secret.
      { guard: strictHop, sensitive: true },
    );
    if (!response.ok || !response.json?.device_code) {
      log('warn', `oauth.device_request_failed server=${serverName} status=${response.status} body=${String(response.text).slice(0, 200)}`);
      throw serviceError(`device_authorization_failed_${response.status}`);
    }
    const info = response.json;
    const session = {
      serverName,
      url: targetUrl,
      metadata,
      client: {
        client_id: client.client_id,
        client_secret: client.client_secret ?? null,
        auth_method: client.token_endpoint_auth_method ?? pickAuthMethod(metadata),
      },
      deviceCode: info.device_code,
      scope: scope ?? null,
      interval: Math.max(2, Number(info.interval) || 5),
      expiresAt: Date.now() + (Number(info.expires_in) || 600) * 1000,
      status: 'pending',
      error: null,
      timer: null,
    };
    deviceSessions.get(serverName)?.timer && clearTimeout(deviceSessions.get(serverName).timer);
    deviceSessions.set(serverName, session);
    startDevicePolling(session);
    log('info', `oauth.device_started server=${serverName} interval=${session.interval}`);
    return {
      userCode: info.user_code,
      verificationUri: info.verification_uri,
      verificationUriComplete: info.verification_uri_complete ?? null,
      expiresIn: Number(info.expires_in) || 600,
      interval: session.interval,
    };
  }

  function startDevicePolling(session) {
    const schedule = () => {
      session.timer = setTimeout(async () => {
        if (deviceSessions.get(session.serverName) !== session) return;
        await pollDeviceOnce(session);
        if (deviceSessions.get(session.serverName) === session) schedule();
      }, session.interval * 1000);
      session.timer.unref?.();
    };
    schedule();
  }

  async function pollDeviceOnce(session) {
    if (Date.now() > session.expiresAt) {
      deviceSessions.delete(session.serverName);
      session.status = 'expired';
      session.error = 'expired_token';
      log('warn', `oauth.device_expired server=${session.serverName}`);
      onChange?.();
      return;
    }
    const form = new URLSearchParams();
    form.set('grant_type', 'urn:ietf:params:oauth:grant-type:device_code');
    form.set('device_code', session.deviceCode);
    form.set('client_id', session.client.client_id);
    const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    if (session.client.client_secret && session.client.auth_method === 'client_secret_post') {
      form.set('client_secret', session.client.client_secret);
    }
    if (session.client.client_secret && session.client.auth_method === 'client_secret_basic') {
      headers.authorization = `Basic ${Buffer.from(`${session.client.client_id}:${session.client.client_secret}`).toString('base64')}`;
    }
    let body = null;
    try {
      const response = await httpJson(
        session.metadata.token_endpoint,
        { method: 'POST', headers, body: form.toString() },
        // The body carries the client secret.
        { guard: strictHop, sensitive: true },
      );
      body = response.json ?? {};
      if (response.ok && body.access_token) {
        deviceSessions.delete(session.serverName);
        session.status = 'granted';
        awaitingConfirmation.set(session.serverName, {
          serverName: session.serverName,
          url: session.url,
          token: body,
          client: session.client,
          scope: session.scope,
          createdAt: Date.now(),
          confirmToken: randomBytes(16).toString('hex'),
        });
        log('info', `oauth.device_authorized server=${session.serverName}`);
        onChange?.();
        return;
      }
    } catch (error) {
      // A transient network failure must not abort the grant: keep polling.
      session.status = 'pending';
      return;
    }
    const error = body.error ?? 'authorization_pending';
    if (error === 'authorization_pending') {
      session.status = 'pending';
      return;
    }
    if (error === 'slow_down') {
      session.interval += 5;
      session.status = 'pending';
      return;
    }
    deviceSessions.delete(session.serverName);
    session.status = 'failed';
    session.error = error;
    log('warn', `oauth.device_failed server=${session.serverName} reason=${error}`);
    onChange?.();
  }

  function deviceStatus(serverName) {
    const session = deviceSessions.get(serverName);
    if (!session) return { status: 'idle' };
    return {
      status: session.status,
      error: session.error ?? null,
      expiresAt: session.expiresAt,
      interval: session.interval,
    };
  }

  function dispose() {
    for (const session of deviceSessions.values()) {
      if (session.timer) clearTimeout(session.timer);
    }
    deviceSessions.clear();
    for (const child of children) {
      try {
        child.kill();
      } catch {
        // child already exited
      }
    }
    children.clear();
    pending.clear();
    awaitingConfirmation.clear();
    discoveryCache.clear();
  }

  return {
    getConfigPath,
    loadSettings,
    saveSettings,
    credentialDir,
    listConfiguredServers,
    buildState,
    probeDiscovery,
    startAuthorization,
    completeAuthorization,
    handleCallback,
    applyGrant,
    writeAuthorization: patchMcpAuthorization,
    startDeviceAuthorization,
    deviceStatus,
    refreshServer,
    refreshExpiring,
    dispose,
  };
}
