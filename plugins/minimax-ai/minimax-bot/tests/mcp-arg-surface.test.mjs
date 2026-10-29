// @ts-check
// What each tool accepts, pinned at the door.
//
// The catalogue declares an enum on six tools. Two different answers are correct, and this file
// pins which one each of them gets:
//
//   - the tool's own message, when the tool has something to say that the schema cannot — the
//     range, and what the value would have changed. A schedule kind and a group reply mode are
//     like that: the tool refuses the value and the group keeps the setting it had;
//   - the door's message, when the tool would otherwise read the value as a different legal one.
//     A skin or a colour is like that: there is no tool-side message, so the door refuses it
//     before anything runs.
//
// And a value of the wrong JSON type is refused at the door for every tool, so a call that does
// not fit the schema never reaches the tool and never changes anything.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// The marketplace keeps the regression tests outside the distributed plugin directory.
const pluginRoot = resolve(process.env.BOT_PLUGIN_ROOT ?? resolve(import.meta.dirname, '..'));
const load = async (relative) => import(pathToFileURL(join(pluginRoot, relative)).href);

const { Store } = await load('miniapp/node/store.mjs');
const { MemoryStore } = await load('miniapp/node/memory.mjs');
const { Engine } = await load('miniapp/node/engine.mjs');
const { Team } = await load('miniapp/node/team.mjs');
const { createMcpHandler } = await load('miniapp/node/mcp.mjs');
const { setLocale } = await load('miniapp/node/i18n.mjs');

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'bot-arg-surface-'));
  const store = new Store(dir);
  const memory = new MemoryStore(dir);
  await store.init();
  await memory.init();
  setLocale('en');
  const engine = new Engine({
    store, memory, logger: { warn() {} }, broadcast: () => {}, retryDelaysMs: [],
  });
  const team = new Team({ store, memory, engine, broadcast: () => {} });
  const handle = createMcpHandler({ team, engine });
  const rpc = async (name, args) => {
    let response;
    await handle({ method: 'POST' }, { writeHead() { return this; }, end(body) { response = JSON.parse(body); } },
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    return response.result;
  };
  t.after(async () => {
    engine.dispose();
    await store.writeChain;
    await rm(dir, { recursive: true, force: true });
  });
  const chief = store.state.bots[0];
  const writer = await team.createBot(chief, { name: 'Writer', role: 'writer' });
  return { dir, store, memory, team, chief, writer, rpc };
}

const textOf = (result) => (result.content ?? []).map((part) => part.text).join('');
/** The path the tool's own answer goes, not the door's. */
const isDoorRefusal = (text) => text.includes('Fix them to match the schema');

test('a schedule kind the tool answers itself reaches the tool', async (t) => {
  const { store, rpc } = await fixture(t);
  const before = store.state.schedules.length;
  const result = await rpc('create_schedule', {
    caller_bot_id: store.state.bots[0].id, kind: 'weekly', time: '09:00', prompt: 'Weekly report',
  });
  const text = textOf(result);
  assert.equal(result.isError, true);
  assert.ok(text.includes('kind must be one of: daily, interval, once'), `the tool answers: ${text}`);
  assert.equal(isDoorRefusal(text), false, 'the door did not answer instead of the tool');
  assert.equal(store.state.schedules.length, before, 'nothing was scheduled');
});

test('a reply mode the tool answers itself reaches the tool', async (t) => {
  const { store, team, chief, writer, rpc } = await fixture(t);
  const group = await team.createGroup(chief, { name: 'Review', members: [writer.id], replyMode: 'all' });
  const result = await rpc('update_group', { caller_bot_id: chief.id, group: group.id, reply_mode: 'ALL' });
  const text = textOf(result);
  assert.equal(result.isError, true);
  assert.ok(text.includes('reply_mode must be one of: admin, all'), `the tool answers: ${text}`);
  assert.equal(isDoorRefusal(text), false, 'the door did not answer instead of the tool');
  assert.equal(store.state.groups.find((entry) => entry.id === group.id).replyMode, 'all',
    'the group keeps the setting it had');
});

test('a memory scope the tool answers itself reaches the tool', async (t) => {
  const { memory, chief, rpc } = await fixture(t);
  for (const tool of ['remember', 'forget', 'recall']) {
    const args = {
      remember: { caller_bot_id: chief.id, scope: 'all', text: 'a note', key: 'k' },
      forget: { caller_bot_id: chief.id, scope: 'all', id: 'abcdef12' },
      recall: { caller_bot_id: chief.id, scope: 'all', query: 'a note' },
    }[tool];
    const result = await rpc(tool, args);
    const text = textOf(result);
    assert.equal(result.isError, true, `${tool} refuses an unknown scope`);
    assert.ok(text.includes('Invalid memory scope "all"'), `${tool} names the scope: ${text}`);
    assert.ok(text.includes('self, team, bot'), `${tool} names the range: ${text}`);
    assert.equal(isDoorRefusal(text), false, `${tool} answered itself`);
  }
  assert.deepEqual(await memory.list('team'), [], 'no team memory was written');
  assert.deepEqual(await memory.list(chief.id), [], 'no bot memory was written');
});

test('a skin or a colour is refused at the door, where nothing has run yet', async (t) => {
  const { store, rpc } = await fixture(t);
  const before = store.state.bots.length;
  const skin = await rpc('create_bot', { name: 'Neon', role: 'writer', instructions: 'i', skin: 'neon' });
  const skinText = textOf(skin);
  assert.equal(skin.isError, true);
  assert.ok(skinText.includes('skin must be one of'), `the door names the range: ${skinText}`);
  assert.ok(skinText.includes('(got neon)'), `the door names the value: ${skinText}`);
  assert.equal(isDoorRefusal(skinText), true, 'the door answered, there is no tool-side message');

  const color = await rpc('create_bot', { name: 'Neon', role: 'writer', instructions: 'i', color: 'neon' });
  const colorText = textOf(color);
  assert.equal(color.isError, true);
  assert.ok(colorText.includes('color must be one of'), `the door names the range: ${colorText}`);
  assert.equal(store.state.bots.length, before, 'no Bot was created');
});

test('a value of the wrong JSON type is refused at the door for every tool', async (t) => {
  const { store, rpc } = await fixture(t);
  const before = store.state.bots.length;
  const result = await rpc('create_bot', { name: 42, role: 'writer', instructions: 'i' });
  const text = textOf(result);
  assert.equal(result.isError, true);
  assert.ok(text.includes('name must be of type string'), `the door names the type: ${text}`);
  assert.ok(text.includes('Fix them to match the schema'), 'the door answered');
  assert.equal(store.state.bots.length, before, 'no Bot was created');

  const enabled = await rpc('update_bot', { caller_bot_id: store.state.bots[0].id, bot: 'Writer', main: 'yes' });
  const enabledText = textOf(enabled);
  assert.equal(enabled.isError, true);
  assert.ok(enabledText.includes('main must be of type boolean'), `the door names the type: ${enabledText}`);
});

test('a legal value still goes through every one of those tools', async (t) => {
  const { store, chief, rpc } = await fixture(t);
  const bot = await rpc('create_bot', {
    caller_bot_id: chief.id, name: 'Gold', role: 'writer', instructions: 'i', skin: 'gold', color: 'pink',
  });
  assert.equal(bot.isError, undefined, textOf(bot));

  const group = await rpc('create_group', {
    caller_bot_id: chief.id, name: 'Review', members: [store.state.bots.at(-1).id], reply_mode: 'all',
  });
  assert.equal(group.isError, undefined, textOf(group));

  const schedule = await rpc('create_schedule', {
    caller_bot_id: chief.id, kind: 'once', in_minutes: 30, prompt: 'Once',
  });
  assert.equal(schedule.isError, undefined, textOf(schedule));

  const remembered = await rpc('remember', {
    caller_bot_id: chief.id, scope: 'self', text: 'a note', key: 'k',
  });
  assert.equal(remembered.isError, undefined, textOf(remembered));
});
