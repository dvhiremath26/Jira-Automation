// Uses the installed source example's real CLI/reporters; no browser or credentials.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { validateSelection, buildGrepFilter } from '../scripts/xray-orchestrator.js';

test('real Playwright discovery and JUnit preserve passing, failing and skipped keys', async () => {
  const source = fileURLToPath(new URL('../source-repo/', import.meta.url));
  const dir = await mkdtemp(join(source, '.contract-'));
  assert.ok(resolve(dir).startsWith(resolve(source) + '\\') || resolve(dir).startsWith(resolve(source) + '/'));
  try {
    await writeFile(join(dir, 'playwright.config.ts'), `
      import base from '../playwright.config';
      export default { ...base, testDir: '.', workers: 1 };
    `);
    await writeFile(join(dir, 'contract.spec.ts'), `
      import { test, expect } from '@playwright/test';
      import { xray } from '../tests/xray';
      test('pass & preserve XML', xray('PROJ-1'), async () => { expect(1).toBe(1); });
      test('intentional failure', xray('PROJ-2'), async () => { expect(1).toBe(2); });
      test.skip('skipped', xray('PROJ-3'), async () => {});
      test('prefix must be excluded', xray('PROJ-10'), async () => { throw Error('must not run'); });
    `);
    const keys = ['PROJ-1', 'PROJ-2', 'PROJ-3'];
    const args = [join(source, 'node_modules/@playwright/test/cli.js'), 'test', '--project=chromium', '--grep', buildGrepFilter(keys)];
    const options = { cwd: dir, encoding: 'utf8', env: { ...process.env, CI: 'true' } };
    const list = spawnSync(process.execPath, [...args, '--list', '--reporter=json'], options);
    assert.equal(list.status, 0, list.stderr);
    validateSelection(JSON.parse(list.stdout), keys);
    const run = spawnSync(process.execPath, args, options);
    assert.equal(run.status, 1, 'The intentional assertion failure must remain a failed process.');
    const xml = await readFile(join(dir, 'results/xray-results.xml'), 'utf8');
    assert.equal((xml.match(/<testcase\s/g) ?? []).length, 3);
    for (const key of keys) assert.ok(xml.includes(`name="test_key" value="${key}"`), `Missing ${key}`);
    assert.ok(xml.includes('<failure'));
    assert.ok(xml.includes('<skipped'));
    // Failure stack code frames may mention adjacent unselected source lines.
    assert.ok(!xml.includes('name="test_key" value="PROJ-10"'));
    assert.ok((await readFile(join(dir, 'TCOE-Report/index.html'), 'utf8')).includes('<html'));
  } finally {
    // dir is a generated child of the verified source directory, never an input path.
    await rm(dir, { recursive: true, force: true });
  }
});
