import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { checkFiles } from '../scripts/lib/rules/files.mjs';
import { createReport } from '../scripts/lib/report.mjs';
import { codes, copyExample, makeTmpRoot } from './helpers.mjs';

async function run(prepare) {
  const root = await makeTmpRoot();
  const { dir } = await copyExample(root);
  const target = (await prepare?.(dir, root)) ?? dir;
  const report = createReport();
  await checkFiles(report, { packageDir: target });
  return report.diagnostics;
}

test('files: baseline passes', async () => {
  assert.deepEqual(await run(), []);
});

test('files: node_modules anywhere is one error per directory, not per file', async () => {
  const diagnostics = await run(async (dir) => {
    await mkdir(path.join(dir, 'miniapp', 'node', 'node_modules', 'dep'), { recursive: true });
    await writeFile(path.join(dir, 'miniapp', 'node', 'node_modules', 'dep', 'index.js'), '');
    await writeFile(path.join(dir, 'miniapp', 'node', 'node_modules', 'dep', 'package.json'), '{}');
  });
  assert.deepEqual(codes(diagnostics), ['PACKAGE_EXCLUDED_DIRECTORY']);
  assert.equal(diagnostics[0].path, 'miniapp/node/node_modules');
});

test('files: non-ASCII and Windows-reserved names are errors', async () => {
  const diagnostics = await run(async (dir) => {
    await writeFile(path.join(dir, '预览.png'), '');
    await writeFile(path.join(dir, 'con.txt'), '');
  });
  assert.deepEqual(codes(diagnostics).sort(), ['PATH_NOT_PORTABLE', 'PATH_NOT_PORTABLE']);
});

test('files: a symlink inside the package is an error', async () => {
  const diagnostics = await run(async (dir) => {
    await symlink(path.join(dir, 'README.md'), path.join(dir, 'README-link.md'));
  });
  assert.deepEqual(codes(diagnostics), ['PACKAGE_SPECIAL_FILE']);
});

test('files: a package root that is itself a symlink is rejected before walking', async () => {
  const diagnostics = await run(async (dir, root) => {
    const link = path.join(root, 'plugins', 'tester', 'linked');
    await symlink(dir, link);
    return link;
  });
  assert.deepEqual(codes(diagnostics), ['PACKAGE_ROOT_SYMLINK']);
});

test('files: two paths that differ only in letter case collide', async () => {
  const diagnostics = await run(async (dir) => {
    await writeFile(path.join(dir, 'Readme.md'), '');
    await mkdir(path.join(dir, 'docs'), { recursive: true });
    await writeFile(path.join(dir, 'docs', 'Preview.png'), '');
    await writeFile(path.join(dir, 'docs', 'preview.png'), '');
  });
  assert.deepEqual(codes(diagnostics).sort(), ['PATH_CASE_COLLISION', 'PATH_CASE_COLLISION']);
});

test('files: a directory and a file that differ only in letter case collide', async () => {
  const diagnostics = await run(async (dir) => {
    await mkdir(path.join(dir, 'Docs'), { recursive: true });
    await writeFile(path.join(dir, 'docs'), '');
  });
  assert.deepEqual(codes(diagnostics), ['PATH_CASE_COLLISION']);
});

test('files: a single file over 16 MiB is an error', async () => {
  const diagnostics = await run(async (dir) => {
    await writeFile(path.join(dir, 'big.bin'), Buffer.alloc(16 * 1024 * 1024 + 1));
  });
  assert.deepEqual(codes(diagnostics), ['PACKAGE_FILE_TOO_LARGE']);
});
