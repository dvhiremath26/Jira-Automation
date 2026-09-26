import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  authenticateXray, fetchTestKeys, buildGrepFilter, importResultsToXray,
  uploadReportToJira, jiraBaseUrl, validateKey, validateSelection, linkExecutionToPlan,
} from '../scripts/xray-orchestrator.js';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of ['XRAY_CLIENT_ID', 'XRAY_CLIENT_SECRET']) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});
const json = body => new Response(JSON.stringify(body), { status: 200 });
const page = (total, start, keys) => json({ data: { getTestPlans: { total: 1, results: [{
  tests: { total, start, results: keys.map(key => ({ jira: { key } })) },
}] } } });

test('exact tag boundaries prevent prefix and embedded matches', () => {
  const regex = new RegExp(buildGrepFilter(['PROJ-1', 'PROJ-2', 'PROJ-1']));
  for (const text of ['case @PROJ-1', '@PROJ-2 @smoke', 'x @PROJ-1 y']) assert.equal(regex.test(text), true);
  for (const text of ['@PROJ-10', 'x@PROJ-1', '@PROJ-1-extra', '@PROJ-1_other']) assert.equal(regex.test(text), false);
  assert.throws(() => buildGrepFilter([]), /empty/);
  for (const value of ['PROJ-1\nattack', 'PROJ-1|.*', 'proj-1', {}, '', 'A-0']) assert.throws(() => validateKey(value));
});

test('fetches 205 keys across three pages', async () => {
  const offsets = [];
  globalThis.fetch = async (_, options) => {
    const { variables } = JSON.parse(options.body);
    offsets.push(variables.start);
    assert.equal(variables.jql, 'key = "PROJ-500"');
    return page(205, variables.start, Array.from({ length: Math.min(100, 205 - variables.start) }, (_, i) => `PROJ-${variables.start + i + 1}`));
  };
  const keys = await fetchTestKeys('PROJ-500', 'token');
  assert.equal(keys.length, 205);
  assert.deepEqual(offsets, [0, 100, 200]);
});

test('rejects empty, missing, stalled, duplicate and changing plans', async () => {
  globalThis.fetch = async () => page(0, 0, []);
  await assert.rejects(fetchTestKeys('P-1', 'token'), /empty/);
  globalThis.fetch = async () => json({ data: { getTestPlans: { total: 0, results: [] } } });
  await assert.rejects(fetchTestKeys('P-1', 'token'), /not found/);
  globalThis.fetch = async () => page(2, 0, []);
  await assert.rejects(fetchTestKeys('P-1', 'token'), /no progress/);
  globalThis.fetch = async () => page(2, 0, ['P-2', 'P-2']);
  await assert.rejects(fetchTestKeys('P-1', 'token'), /Duplicate/);
  let call = 0;
  globalThis.fetch = async () => ++call === 1 ? page(2, 0, ['P-2']) : page(3, 1, ['P-3']);
  await assert.rejects(fetchTestKeys('P-1', 'token'), /changed/);
});

test('rejects GraphQL errors even with HTTP 200, without logging raw content', async () => {
  globalThis.fetch = async () => json({ errors: [{ message: 'sensitive server content' }] });
  await assert.rejects(fetchTestKeys('P-1', 'token'), error => /GraphQL/.test(error.message) && !error.message.includes('sensitive'));
});

test('authentication uses Cloud client credentials and checks token shape', async () => {
  process.env.XRAY_CLIENT_ID = 'test-client';
  process.env.XRAY_CLIENT_SECRET = 'test-secret';
  globalThis.fetch = async (url, options) => {
    assert.ok(url.endsWith('/api/v2/authenticate'));
    assert.deepEqual(JSON.parse(options.body), { client_id: 'test-client', client_secret: 'test-secret' });
    return json('jwt-token');
  };
  assert.equal(await authenticateXray(), 'jwt-token');
  globalThis.fetch = async () => json({ token: 'wrong-format' });
  await assert.rejects(authenticateXray(), /invalid token/);
});

test('authentication fails cleanly on HTTP errors', async () => {
  process.env.XRAY_CLIENT_ID = 'client'; process.env.XRAY_CLIENT_SECRET = 'secret';
  globalThis.fetch = async () => new Response('secret-response', { status: 401 });
  await assert.rejects(authenticateXray(), /HTTP 401/);
});

test('retries transient reads', async () => {
  let calls = 0;
  globalThis.fetch = async () => ++calls === 1 ? new Response('', { status: 503, headers: { 'retry-after': '0' } }) : page(1, 0, ['P-2']);
  assert.deepEqual(await fetchTestKeys('P-1', 'token'), ['P-2']);
  assert.equal(calls, 2);
});

test('links numeric Xray IDs rather than Jira keys', async () => {
  let call = 0;
  globalThis.fetch = async (_, options) => {
    if (++call === 1) return json({ data: {
      getTestPlans: { total: 1, results: [{ issueId: '100' }] },
      getTestExecutions: { total: 1, results: [{ issueId: '200' }] },
    } });
    assert.deepEqual(JSON.parse(options.body).variables, { plan: '100', executions: ['200'] });
    return json({ data: { addTestExecutionsToTestPlan: { addedTestExecutions: ['200'], warning: null } } });
  };
  await linkExecutionToPlan('P-1', 'P-2', 'token');
});

test('repeated association confirms existing membership despite mutation warning', async () => {
  let call = 0;
  globalThis.fetch = async () => {
    call++;
    if (call === 1) return json({ data: {
      getTestPlans: { total: 1, results: [{ issueId: '100' }] },
      getTestExecutions: { total: 1, results: [{ issueId: '200' }] },
    } });
    if (call === 2) return json({ data: { addTestExecutionsToTestPlan: { addedTestExecutions: [], warning: 'already linked' } } });
    return json({ data: { getTestExecution: { testPlans: { total: 1, start: 0, results: [{ issueId: '100' }] } } } });
  };
  await linkExecutionToPlan('P-1', 'P-2', 'token');
  assert.equal(call, 3);
});

test('rejects unexpected pagination offsets and malformed JSON responses', async () => {
  globalThis.fetch = async () => page(1, 100, ['P-1']);
  await assert.rejects(fetchTestKeys('P-2', 'token'), /pagination/);
  globalThis.fetch = async () => new Response('<html>service unavailable</html>', { status: 200 });
  await assert.rejects(fetchTestKeys('P-2', 'token'), /JSON/);
});

test('imports raw XML into the requested existing Execution, no retry on write', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xray-test-'));
  try {
    const file = join(dir, 'results.xml');
    await writeFile(file, '<testsuites><testsuite><testcase name="x"/></testsuite></testsuites>');
    globalThis.fetch = async (url, options) => {
      assert.ok(url.endsWith('/import/execution/junit?testExecKey=P-2'));
      assert.equal(options.headers['Content-Type'], 'text/xml');
      assert.ok(Buffer.isBuffer(options.body));
      return json({ key: 'P-2' });
    };
    await importResultsToXray('P-2', file, 'token');
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response('', { status: 503 }); };
    await assert.rejects(importResultsToXray('P-2', file, 'token'), /HTTP 503/);
    assert.equal(calls, 1);
    await writeFile(file, '<testsuites/>');
    await assert.rejects(importResultsToXray('P-2', file, 'token'), /no test cases/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Jira uploads only index.html with native multipart, Basic auth and CSRF header', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jira-test-'));
  try {
    const file = join(dir, 'index.html');
    const html = '<!DOCTYPE html><html><body>Latest report</body></html>';
    await writeFile(file, html);
    globalThis.fetch = async (url, options) => {
      assert.equal(url, 'https://example.atlassian.net/rest/api/3/issue/P-2/attachments');
      assert.equal(options.headers['X-Atlassian-Token'], 'no-check');
      assert.equal(options.headers.Authorization, `Basic ${Buffer.from('qa@example.com:secret').toString('base64')}`);
      assert.equal(options.headers['Content-Type'], undefined);
      assert.deepEqual([...options.body.keys()], ['file']);
      assert.equal(options.body.get('file').name, 'index.html');
      assert.equal(options.body.get('file').type, 'text/html');
      assert.equal(await options.body.get('file').text(), html);
      return json([{ id: '10', filename: 'index.html' }]);
    };
    await uploadReportToJira('P-2', file, 'example', 'qa@example.com', 'secret');
    globalThis.fetch = async () => { throw new Error('Invalid reports must not be uploaded'); };
    await writeFile(file, 'not HTML');
    await assert.rejects(uploadReportToJira('P-2', file, 'example', 'qa@example.com', 'secret'), /not an HTML/);
    await writeFile(file, '');
    await assert.rejects(uploadReportToJira('P-2', file, 'example', 'qa@example.com', 'secret'), /empty/);
  } finally { await rm(dir, { recursive: true, force: true }); }
  for (const host of ['https://example.atlassian.net', 'evil.com', 'example.atlassian.net@evil.com', 'example/path']) assert.throws(() => jiraBaseUrl(host));
});

test('discovery enforces complete, unambiguous tag-to-annotation coverage', () => {
  const report = { suites: [{ specs: [{ tags: ['P-1', 'smoke'], tests: [{ annotations: [{ type: 'test_key', description: 'P-1' }] }] }] }] };
  validateSelection(report, ['P-1']);
  assert.throws(() => validateSelection(report, ['P-1', 'P-2']), /P-2 matched 0/);
  const duplicate = structuredClone(report);
  duplicate.suites[0].specs.push(duplicate.suites[0].specs[0]);
  assert.throws(() => validateSelection(duplicate, ['P-1']), /matched 2/);
  report.suites[0].specs[0].tests[0].annotations = [];
  assert.throws(() => validateSelection(report, ['P-1']), /annotation/);
});
