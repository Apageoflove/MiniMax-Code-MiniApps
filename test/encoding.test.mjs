import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validatePackage } from '../scripts/lib/package.mjs';
import { codes, copyExample, makeTmpRoot } from './helpers.mjs';

// The bytes of a few Chinese characters in GBK, which is what a file saved on a Chinese Windows
// machine holds. Node has no GBK codec, so the bytes are written out directly.
const GBK = new Map([
  ['中', [0xd6, 0xd0]],
  ['文', [0xce, 0xc4]],
  ['字', [0xd7, 0xd6]],
  ['节', [0xbd, 0xda]],
]);

function asGbk(text) {
  const bytes = [];
  for (const character of text) {
    const gbk = GBK.get(character);
    if (gbk) bytes.push(...gbk);
    else bytes.push(...Buffer.from(character, 'utf8'));
  }
  return Buffer.from(bytes);
}

async function writeGbkJson(file, value) {
  await writeFile(file, asGbk(`${JSON.stringify(value, null, 2)}\n`));
}

test('package: a manifest saved in another encoding is refused', async () => {
  const root = await makeTmpRoot();
  const { dir } = await copyExample(root);
  const file = path.join(dir, '.minimax-plugin', 'plugin.json');
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  await writeGbkJson(file, { ...manifest, description: '中文说明' });

  // The bytes are not UTF-8, but they are still JSON once they are read the lenient way: the
  // Chinese characters become replacement characters and the rest of the file is untouched. That
  // is how the file used to pass the check while the Host refused to read it at all.
  const lenient = (await readFile(file)).toString('utf8');
  assert.doesNotThrow(() => JSON.parse(lenient));
  const diagnostics = await validatePackage(dir);
  assert.ok(codes(diagnostics).includes('MANIFEST_UNREADABLE'), `expected a refusal, got ${codes(diagnostics).join(', ')}`);
  assert.match(diagnostics.find((d) => d.code === 'MANIFEST_UNREADABLE').message, /UTF-8/u);
});

test('package: a package.json saved in another encoding is refused', async () => {
  const root = await makeTmpRoot();
  const { dir } = await copyExample(root);
  const file = path.join(dir, 'package.json');
  const packageJson = JSON.parse(await readFile(file, 'utf8'));
  await writeGbkJson(file, { ...packageJson, description: '中文说明' });

  const diagnostics = await validatePackage(dir);
  assert.ok(codes(diagnostics).includes('MCODE_UNREADABLE'), `expected a refusal, got ${codes(diagnostics).join(', ')}`);
});

test('package: a miniapp.json saved in another encoding is refused', async () => {
  const root = await makeTmpRoot();
  const { dir } = await copyExample(root);
  const file = path.join(dir, 'miniapp', 'miniapp.json');
  const miniapp = JSON.parse(await readFile(file, 'utf8'));
  await writeGbkJson(file, { ...miniapp, description: '中文说明' });

  const diagnostics = await validatePackage(dir);
  assert.ok(codes(diagnostics).includes('MINIAPP_UNREADABLE'), `expected a refusal, got ${codes(diagnostics).join(', ')}`);
});

test('package: a manifest in UTF-8 with Chinese text still passes', async () => {
  const root = await makeTmpRoot();
  const { dir } = await copyExample(root);
  const file = path.join(dir, '.minimax-plugin', 'plugin.json');
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, `${JSON.stringify({ ...manifest, description: '中文说明' }, null, 2)}\n`);

  assert.deepEqual(await validatePackage(dir), []);
});
