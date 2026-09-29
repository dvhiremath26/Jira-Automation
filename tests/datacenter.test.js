import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDataCenterClient, dataCenterBaseUrl, deploymentMode } from '../scripts/xray-datacenter.js';
import { main } from '../scripts/xray-orchestrator.js';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
afterEach(() => { globalThis.fetch = originalFetch; process.env = { ...originalEnv }; });
const json = value => new Response(JSON.stringify(value));
function client() {
  process.env.JIRA_BASE_URL = 'https://jira.example.org:8443/jira/';
  process.env.JIRA_PAT = 'test-pat';
  return createDataCenterClient();
}

test('deployment defaults to Cloud and rejects typos; DC URL preserves context and port', () => {
  delete process.env.JIRA_DEPLOYMENT;
  assert.equal(deploymentMode(), 'cloud');
  process.env.JIRA_DEPLOYMENT = 'datacenter';
  assert.equal(deploymentMode(), 'datacenter');
  process.env.JIRA_DEPLOYMENT = 'data-centre';
  assert.throws(deploymentMode, /JIRA_DEPLOYMENT/);
  assert.equal(dataCenterBaseUrl('https://jira.example.org:8443/jira/'), 'https://jira.example.org:8443/jira');
  for (const url of ['jira.example.org', 'http://jira.example.org', 'https://user:pass@jira.example.org', 'https://jira.example.org?token=x', 'https://jira.example.org/#x']) {
    assert.throws(() => dataCenterBaseUrl(url), /JIRA_BASE_URL/);
  }
});

test('DC selection follows even short pages, using PAT and never Cloud endpoints', async () => {
  const dc = client();
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, `https://jira.example.org:8443/jira/rest/raven/1.0/api/testplan/TPA-2/test?limit=100&page=${++calls}`);
    assert.equal(options.headers.Authorization, 'Bearer test-pat');
    assert.equal(options.redirect, 'error');
    return json(calls < 4 ? [{ key: `TPA-${calls + 10}` }] : []);
  };
  assert.deepEqual(await dc.fetchTestKeys('TPA-2'), ['TPA-11', 'TPA-12', 'TPA-13']);
  assert.equal(calls, 4);
});

test('DC selection rejects empty, malformed and repeated pages', async () => {
  const dc = client();
  for (const response of [[], {}, [{ key: 'invalid' }], [{ key: 'TPA-5' }]]) {
    globalThis.fetch = async () => json(response);
    await assert.rejects(dc.fetchTestKeys('TPA-2'), /empty|Invalid|Duplicate/);
  }
});

test('DC association verifies membership and does not add Execution tests to Plan', async () => {
  const dc = client();
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    assert.ok(url.endsWith('/testplan/TPA-2/testexecution'));
    calls++;
    if (calls === 2) {
      assert.equal(options.method, 'POST');
      assert.deepEqual(JSON.parse(options.body), { add: ['TPA-10'], addTestsToPlan: false });
      return new Response(null, { status: 204 });
    }
    return json(calls === 1 ? [] : [{ key: 'TPA-10' }]);
  };
  await dc.linkExecutionToPlan('TPA-2', 'TPA-10');
  assert.equal(calls, 3);
  calls = 3;
  await dc.linkExecutionToPlan('TPA-2', 'TPA-10');
  assert.equal(calls, 4);
});

test('DC association detects API errors inside HTTP 200 and unconfirmed writes', async () => {
  const dc = client();
  for (const result of [['Not a Test Execution'], []]) {
    globalThis.fetch = async (_url, options) => json(options.method === 'POST' ? result : []);
    await assert.rejects(dc.linkExecutionToPlan('TPA-2', 'TPA-10'), /rejected|confirm/);
  }
});

test('DC CLI imports multipart JUnit and attaches only index.html with no Cloud credentials', async () => {
  client();
  process.env.JIRA_DEPLOYMENT = 'datacenter';
  process.env.TEST_EXEC_KEY = 'TPA-10';
  for (const key of ['XRAY_CLIENT_ID', 'XRAY_CLIENT_SECRET', 'JIRA_DOMAIN', 'JIRA_USER_EMAIL', 'JIRA_API_TOKEN']) delete process.env[key];
  const directory = await mkdtemp(join(tmpdir(), 'dc-contract-'));
  try {
    process.env.XML_REPORT_PATH = join(directory, 'results.xml');
    process.env.HTML_REPORT_PATH = join(directory, 'latest.html');
    await writeFile(process.env.XML_REPORT_PATH, '<testsuite><testcase name="test"/></testsuite>');
    await writeFile(process.env.HTML_REPORT_PATH, '<html><body>Report</body></html>');
    let calls = 0;
    globalThis.fetch = async (url, options) => {
      calls++;
      assert.equal(options.headers.Authorization, 'Bearer test-pat');
      assert.equal(options.headers['Content-Type'], undefined);
      assert.deepEqual([...options.body.keys()], ['file']);
      const file = options.body.get('file');
      if (calls === 1) {
        assert.ok(url.endsWith('/rest/raven/1.0/import/execution/junit?testExecKey=TPA-10'));
        assert.equal(file.name, 'xray-results.xml');
        assert.match(await file.text(), /testcase/);
        return json({ testExecIssue: { key: 'TPA-10' } });
      }
      assert.ok(url.endsWith('/rest/api/2/issue/TPA-10/attachments'));
      assert.equal(file.name, 'index.html');
      assert.equal(options.headers['X-Atlassian-Token'], 'no-check');
      return json([{ id: '123', filename: 'index.html' }]);
    };
    await main('import');
    await main('attach');
    assert.equal(calls, 2);
    globalThis.fetch = async () => json({ testExecIssue: { key: 'TPA-99' } });
    await assert.rejects(main('import'), /confirm/);
    await assert.rejects(main('attach'), /confirm/);
    let writes = 0;
    globalThis.fetch = async () => { writes++; return new Response('private server detail', { status: 503 }); };
    await assert.rejects(main('import'), /HTTP 503/);
    assert.equal(writes, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('DC PAT is required and errors do not expose credentials or server response bodies', async () => {
  const dc = client();
  globalThis.fetch = async () => new Response('sensitive detail', { status: 401 });
  await assert.rejects(dc.fetchTestKeys('TPA-2'), error => /HTTP 401/.test(error.message) && !/sensitive|test-pat/.test(error.message));
  delete process.env.JIRA_PAT;
  assert.throws(createDataCenterClient, /Missing environment variable JIRA_PAT/);
});

test('DC CLI selects and records deployment without Cloud auth; run rejects a different deployment', async () => {
  client();
  process.env.JIRA_DEPLOYMENT = 'datacenter';
  process.env.TEST_PLAN_KEY = 'TPA-2';
  process.env.TEST_EXEC_KEY = 'TPA-10';
  delete process.env.XRAY_CLIENT_ID;
  delete process.env.XRAY_CLIENT_SECRET;
  delete process.env.GITHUB_OUTPUT;
  const directory = await mkdtemp(join(tmpdir(), 'dc-selection-'));
  const cwd = process.cwd();
  try {
    process.chdir(directory);
    globalThis.fetch = async url => {
      if (url.endsWith('/testexecution')) return json([{ key: 'TPA-10' }]);
      if (url.endsWith('page=1')) return json([{ key: 'TPA-5' }]);
      assert.ok(url.endsWith('page=2'));
      return json([]);
    };
    await main('validate');
    await main('select');
    const saved = await readFile('.state/selection.json', 'utf8');
    assert.deepEqual(JSON.parse(saved).keys, ['TPA-5']);
    assert.equal(JSON.parse(saved).mode, 'datacenter');
    assert.ok(!saved.includes('test-pat'));
    process.env.JIRA_DEPLOYMENT = 'cloud';
    await assert.rejects(main('run'), /different Jira deployment/);
  } finally {
    process.chdir(cwd);
    await rm(directory, { recursive: true, force: true });
  }
});
