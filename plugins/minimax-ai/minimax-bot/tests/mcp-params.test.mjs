import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../miniapp/node/memory.mjs';
import { Store } from '../miniapp/node/store.mjs';
import { Engine } from '../miniapp/node/engine.mjs';
import { Team } from '../miniapp/node/team.mjs';
import { createMcpHandler } from '../miniapp/node/mcp.mjs';
import { setLocale } from '../miniapp/node/i18n.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'bot-mcp-params-'));
  const memory = new MemoryStore(dir);
  const store = new Store(dir);
  await memory.init();
  await store.init();
  setLocale('en');
  const logged = [];
  const logger = {
    warn: (...args) => logged.push(args),
    info: () => {},
    error: () => {},
    debug: () => {},
  };
  const engine = new Engine({ store, memory, broadcast() {}, logger });
  const team = new Team({ store, memory, engine, broadcast() {} });
  const handle = createMcpHandler({ team, engine });
  const rpc = async (method, params) => {
    let result;
    await handle({ method: 'POST' }, { writeHead() { return this; }, end(body) { result = JSON.parse(body); } },
      { jsonrpc: '2.0', id: 1, method, params });
    return result.result;
  };
  t.after(async () => {
    engine.dispose?.();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, memory, store, engine, team, rpc, logged };
}

const call = (rpc, name, args) => rpc('tools/call', { name, arguments: args });

test('a scope outside the values the tool declares is refused with those values, not a crash', async (t) => {
  const { rpc } = await fixture(t);
  for (const [name, args] of [
    ['remember', { text: 'a note', key: 'probe.note', scope: 'all' }],
    ['forget', { id: 'deadbeef', scope: 'all' }],
    ['recall', { scope: 'all' }],
  ]) {
    const result = await call(rpc, name, args);
    assert.equal(result.isError, true, `${name} must refuse an unknown scope`);
    const text = result.content[0].text;
    assert.doesNotMatch(text, /Cannot read properties|TypeError|undefined \(reading/, `${name} must not answer with an internal fault`);
    for (const allowed of ['self', 'team', 'bot']) {
      assert.match(text, new RegExp(allowed), `${name} must name the allowed scope ${allowed}`);
    }
  }
  setLocale('zh');
  const zh = await call(rpc, 'remember', { text: 'a note', key: 'probe.note', scope: 'all' });
  setLocale('en');
  assert.equal(zh.isError, true);
  // The tool answers a scope: it knows the range and what the value would have changed, so its
  // message is the one the model reads, not the schema's.
  assert.match(zh.content[0].text, /无效的记忆范围/);
  assert.match(zh.content[0].text, /self, team, bot/);
  assert.doesNotMatch(zh.content[0].text, /Cannot read properties/);
});

test('an argument of the wrong JSON type is refused instead of guessed', async (t) => {
  const { rpc } = await fixture(t);
  const result = await call(rpc, 'remember', { text: 'a note', key: 'probe.note', scope: 7 });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /scope/);
  assert.doesNotMatch(result.content[0].text, /Cannot read properties/);
});

test('a refused scope leaves every memory untouched', async (t) => {
  const { rpc, memory, store } = await fixture(t);
  const bot = store.state.bots[0];
  await memory.remember('team', { text: 'team note', key: 'team.note' });
  await memory.remember(bot.id, { text: 'own note', key: 'own.note' });
  const teamBefore = await memory.list('team');
  const ownBefore = await memory.list(bot.id);
  for (const args of [
    { caller_bot_id: bot.id, text: 'should not be saved', key: 'probe.note', scope: 'all' },
    { text: 'should not be saved', key: 'probe.note', scope: 'all' },
  ]) {
    const result = await call(rpc, 'remember', args);
    assert.equal(result.isError, true);
    assert.doesNotMatch(result.content[0].text, /Cannot read properties/);
  }
  assert.deepEqual(await memory.list('team'), teamBefore);
  assert.deepEqual(await memory.list(bot.id), ownBefore);
});

test('a legal scope keeps its behaviour, and an unknown one is refused instead of taken for a legal one', async (t) => {
  const { rpc, memory, store } = await fixture(t);
  const bot = store.state.bots[0];
  const own = await call(rpc, 'remember', { caller_bot_id: bot.id, text: 'own note', key: 'own.note', scope: 'self' });
  assert.equal(own.isError, undefined);
  assert.equal(JSON.parse(own.content[0].text).scope, bot.id);
  assert.deepEqual((await memory.list(bot.id)).map((entry) => entry.text), ['own note']);
  const shared = await call(rpc, 'remember', { caller_bot_id: bot.id, text: 'team note', key: 'team.note', scope: 'team' });
  assert.equal(shared.isError, undefined);
  assert.equal(JSON.parse(shared.content[0].text).scope, 'team');
  assert.deepEqual((await memory.list('team')).map((entry) => entry.text), ['team note']);
  const other = await call(rpc, 'remember', { caller_bot_id: bot.id, text: 'other note', key: 'other.note', scope: 'bot', target_bot: bot.id });
  assert.equal(other.isError, undefined);
  assert.equal(JSON.parse(other.content[0].text).scope, bot.id);
  const refused = await call(rpc, 'remember', { caller_bot_id: bot.id, text: 'wrong scope', key: 'wrong.note', scope: 'all' });
  assert.equal(refused.isError, true);
  assert.doesNotMatch(refused.content[0].text, /Cannot read properties/);
  assert.equal((await memory.list(bot.id)).length, 2);
});

test('the memory layer refuses an unknown scope and never dereferences a missing caller', async (t) => {
  const { team } = await fixture(t);
  let unknown;
  try {
    team.memoryScope(undefined, 'all', undefined, true);
  } catch (error) {
    unknown = error;
  }
  assert.ok(unknown, 'an unknown scope must be refused');
  assert.notEqual(unknown.name, 'TypeError');
  assert.equal(unknown.code, 'invalid');
  assert.match(unknown.message, /self/);
  assert.match(unknown.message, /team/);
  assert.match(unknown.message, /bot/);
  let missing;
  try {
    team.memoryScope(undefined, 'self', undefined, true);
  } catch (error) {
    missing = error;
  }
  assert.ok(missing, 'a request without a caller must be refused');
  assert.notEqual(missing.name, 'TypeError');
  assert.equal(missing.code, 'invalid');
});

test('a fault the plugin does not own is logged, not shown to the model', async (t) => {
  const { rpc, store, logged } = await fixture(t);
  const bot = store.state.bots[0];
  store.getBot = () => { throw new TypeError('internal detail: /srv/secret/path.js'); };
  const result = await call(rpc, 'list_team', { caller_bot_id: bot.id });
  assert.equal(result.isError, true);
  assert.doesNotMatch(result.content[0].text, /internal detail|secret/);
  assert.ok(
    logged.some((entry) => entry[0] === 'minimax_bot.tool_failed' && /internal detail/.test(JSON.stringify(entry))),
    'the detail belongs in the log',
  );
});
