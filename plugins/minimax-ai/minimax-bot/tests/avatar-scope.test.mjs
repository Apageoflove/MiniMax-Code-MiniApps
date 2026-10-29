// @ts-check
// The avatar field must not become a way to read files off this computer.
//
// The point of this file: the claims the fix makes are not left to a code review.
//
//   1. an absolute path outside the Mini App's data directory is refused, the file is never
//      read, and nothing lands in the avatar library;
//   2. the refusal says nothing about the file: the path is not echoed, and an existing
//      image, an existing non-image and a missing path all get the same answer, so the field
//      is not an existence-and-type probe of the file system;
//   3. a file this process may not even open is refused the same clean way, which is only
//      possible if nobody tried to open it;
//   4. the model-facing tools (create_bot / update_bot) refuse the same path;
//   5. the library file name branch is untouched: a Bot still gets an avatar from the
//      library, and the page's own upload still lands in the library.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const pluginRoot = join(import.meta.dirname, '..');
const { start } = await import(pathToFileURL(join(pluginRoot, 'miniapp/node/server.mjs')).href);

/** A real 1x1 PNG, so the plugin's own image sniffing accepts it. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'bot-avatar-'));
  const outside = await mkdtemp(join(tmpdir(), 'bot-outside-'));
  const probe = createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
  const app = await start({
    pluginRoot,
    dataDir,
    listen: { host: '127.0.0.1', port },
    signal: new AbortController().signal,
    logger: { info() {}, warn() {}, error() {} },
  });
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await app.dispose();
    await rm(dataDir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  return {
    dataDir,
    outside,
    base,
    /** The library on disk: what the plugin copied in, if anything. */
    library: () => readdir(join(dataDir, 'avatars')).catch(() => []),
  };
}

/** `POST /api/bots`, the page's own route. */
async function postBot(base, name, avatar) {
  const response = await fetch(`${base}/api/bots`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, avatar }),
  });
  return { status: response.status, body: await response.json() };
}

/** One MCP tool call, the way a Bot reaches the plugin. */
async function callTool(base, name, args) {
  const response = await fetch(`${base}/mcp/minimax-bot`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  return (await response.json()).result;
}

const messageOf = (result) => String(result?.content?.[0]?.text ?? '');

// ---------------------------------------------------------------- 1. the file is not read

test('an absolute path outside the data directory is refused, and the file is never read', async (t) => {
  const { outside, base, library } = await fixture(t);
  const secret = join(outside, 'outside-secret.png');
  await writeFile(secret, PNG);

  const result = await postBot(base, 'Escaped', secret);
  assert.equal(result.status, 400, 'a path outside the data directory is not an avatar source');
  assert.equal(result.body.error, 'invalid');
  assert.deepEqual(await library(), [], 'the file did not land in the avatar library');

  const state = await (await fetch(`${base}/api/state`)).json();
  assert.ok(!state.bots.some((bot) => bot.name === 'Escaped'), 'the Bot was not created');

  const gallery = await (await fetch(`${base}/api/avatars`)).json();
  assert.deepEqual(gallery.avatars, [], 'the library lists nothing');
});

// ---------------------------------------------------------------- 2. the answer says nothing

test('every outside path gets the same answer, so the field cannot probe the file system', async (t) => {
  const { outside, base } = await fixture(t);
  const image = join(outside, 'there.png');
  const text = join(outside, 'there.txt');
  await writeFile(image, PNG);
  await writeFile(text, 'not an image at all');

  const answers = [];
  for (const value of [image, text, join(outside, 'missing.png')]) {
    answers.push(await postBot(base, 'Probe', value));
  }
  for (const answer of answers) {
    assert.equal(answer.status, 400);
    assert.ok(!answer.body.message.includes(outside), 'no part of the path comes back');
  }
  assert.equal(answers[0].body.message, answers[1].body.message, 'an existing image and an existing non-image answer alike');
  assert.equal(answers[0].body.message, answers[2].body.message, 'a missing path answers alike');
});

// ---------------------------------------------------------------- 3. nobody opened the file

test('a file this process may not open is refused the same clean way, so nobody tried to open it', async (t) => {
  const { outside, base, library } = await fixture(t);
  const locked = join(outside, 'locked.png');
  await writeFile(locked, PNG);
  await chmod(locked, 0o000);

  const result = await postBot(base, 'Locked', locked);
  assert.equal(result.status, 400, 'the plugin answers about the avatar, not about a permission error');
  assert.equal(result.body.error, 'invalid');
  assert.ok(!result.body.message.includes(outside), 'no part of the path comes back');
  assert.deepEqual(await library(), [], 'nothing landed in the avatar library');
});

// ---------------------------------------------------------------- 4. the model-facing tools

test('the model-facing tools refuse the same path', async (t) => {
  const { outside, base, library } = await fixture(t);
  const secret = join(outside, 'outside-secret.png');
  await writeFile(secret, PNG);

  const created = await callTool(base, 'create_bot', { name: 'Mcp Escaped', avatar: secret });
  assert.equal(created.isError, true, 'create_bot refuses the path');
  assert.ok(!messageOf(created).includes(outside), 'the path is not echoed');
  assert.deepEqual(await library(), [], 'nothing landed in the avatar library');

  const plain = await callTool(base, 'create_bot', { name: 'Mcp Plain' });
  assert.notEqual(plain.isError, true, 'a Bot without an avatar is still created');
  const botId = JSON.parse(messageOf(plain)).bot_id;
  const updated = await callTool(base, 'update_bot', { bot: botId, avatar: secret });
  assert.equal(updated.isError, true, 'update_bot refuses the path');
  assert.ok(!messageOf(updated).includes(outside), 'the path is not echoed');
  assert.deepEqual(await library(), [], 'nothing landed in the avatar library');
});

// ---------------------------------------------------------------- 5. the library branch is untouched

test('a library file name still sets an avatar, and the library file is not copied again', async (t) => {
  const { dataDir, base, library } = await fixture(t);
  await mkdir(join(dataDir, 'avatars'), { recursive: true });
  await writeFile(join(dataDir, 'avatars', 'library.png'), PNG);

  const result = await postBot(base, 'Library', 'library.png');
  assert.equal(result.status, 200);
  assert.equal(result.body.bot.avatar, 'library.png', 'the library file name is kept as it is');
  assert.deepEqual(await library(), ['library.png'], 'the library file is not copied again');

  const served = await fetch(`${base}/api/avatars/library.png`);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), PNG, 'the library file is served as it is');
});

test('the page upload still lands in the library', async (t) => {
  const { dataDir, base, library } = await fixture(t);
  const response = await fetch(`${base}/api/avatars`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ avatar: `data:image/png;base64,${PNG.toString('base64')}` }),
  });
  assert.equal(response.status, 200);
  const { avatar } = await response.json();
  assert.match(avatar, /^avatar-[a-f0-9]{64}\.png$/);
  assert.deepEqual(await library(), [avatar]);
  assert.deepEqual(await readFile(join(dataDir, 'avatars', avatar)), PNG, 'the uploaded image is stored as it is');
});
