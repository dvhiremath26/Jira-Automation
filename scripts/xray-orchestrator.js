import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const XRAY = 'https://xray.cloud.getxray.app/api/v2';
const KEY = /^[A-Z][A-Z0-9_]*-[1-9]\d*$/;
const STATE = '.state/selection.json';

export function validateKey(value, label = 'issue key') {
  if (typeof value !== 'string' || !KEY.test(value) || value.length > 100) {
    throw new Error(`Invalid ${label}; expected an uppercase Jira key such as PROJ-101.`);
  }
  return value;
}

function required(name) {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`Missing environment variable ${name}.`);
  return value;
}

/** Bounded timeouts; retries only for read/auth operations, never ambiguous writes.
 * Response bodies are deliberately excluded from errors to avoid leaking credentials.
 */
export async function requestJson(url, options, { label, retry = false } = {}) {
  for (let attempt = 0; ; attempt++) {
    let response;
    let body;
    try {
      response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(60_000) });
      body = await response.text();
    } catch {
      if (retry && attempt < 2) { await delay(500 * 2 ** attempt); continue; }
      throw new Error(`${label}: network failure or timeout. Check connectivity; writes may have completed.`);
    }
    if (!response.ok) {
      if (retry && attempt < 2 && [429, 502, 503, 504].includes(response.status)) {
        const header = response.headers.get('retry-after');
        const seconds = header === null ? NaN : Number(header);
        const wait = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header ?? '') - Date.now();
        await delay(Math.min(30_000, Math.max(500, Number.isFinite(wait) ? wait : 500 * 2 ** attempt)));
        continue;
      }
      throw new Error(`${label}: HTTP ${response.status}. Check credentials, permissions, keys and service limits.`);
    }
    try { return JSON.parse(body); } catch { throw new Error(`${label}: expected a JSON response.`); }
  }
}

export async function authenticateXray() {
  const token = await requestJson(`${XRAY}/authenticate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: required('XRAY_CLIENT_ID'), client_secret: required('XRAY_CLIENT_SECRET') }),
  }, { label: 'Xray authentication', retry: true });
  if (typeof token !== 'string' || !token || /\s/.test(token)) throw new Error('Xray returned an invalid token.');
  // Token remains in memory and is never written to Actions outputs or disk.
  return token;
}

async function graphql(query, variables, token, retry = true) {
  const result = await requestJson(`${XRAY}/graphql`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  }, { label: 'Xray GraphQL', retry });
  if (result?.errors?.length || !result?.data) {
    throw new Error('Xray GraphQL returned errors or missing data. Check schema, issue visibility and permissions.');
  }
  return result.data;
}

export async function fetchTestKeys(testPlanKey, token) {
  validateKey(testPlanKey, 'Test Plan key');
  const keys = new Set();
  let start = 0;
  let expectedTotal;
  do {
    const data = await graphql(`query PlanTests($jql: String!, $start: Int!) {
      getTestPlans(jql: $jql, limit: 1) {
        total results { tests(limit: 100, start: $start) {
          total start results { jira(fields: ["key"]) }
        } }
      }
    }`, { jql: `key = "${testPlanKey}"`, start }, token);
    const plans = data.getTestPlans;
    if (plans?.total !== 1 || plans.results?.length !== 1) throw new Error('Test Plan not found or not visible in Xray.');
    const page = plans.results[0].tests;
    if (!page || !Number.isInteger(page.total) || page.total < 0 || page.start !== start || !Array.isArray(page.results)) {
      throw new Error('Invalid Xray pagination response.');
    }
    expectedTotal ??= page.total;
    if (page.total !== expectedTotal) throw new Error('Test Plan changed while paging; retry with a stable plan.');
    if (page.results.length > 100 || start + page.results.length > page.total) throw new Error('Invalid Xray page size.');
    if (!page.results.length && start < page.total) throw new Error('Xray pagination made no progress.');
    for (const test of page.results) {
      const key = validateKey(test?.jira?.key, 'Test key returned by Xray');
      if (keys.has(key)) throw new Error('Duplicate Test across Xray pages; plan may have changed.');
      keys.add(key);
    }
    start += page.results.length;
  } while (start < expectedTotal);
  if (!keys.size) throw new Error('Test Plan is empty; refusing to run the entire suite.');
  console.log(`Selected ${keys.size} Tests from ${testPlanKey}.`);
  return [...keys];
}

export function buildGrepFilter(testKeys) {
  if (!Array.isArray(testKeys) || !testKeys.length) throw new Error('Cannot build a filter for an empty selection.');
  const keys = [...new Set(testKeys.map(key => validateKey(key)))];
  // Whitespace boundaries prevent PROJ-1 matching PROJ-10 or custom suffixed tags.
  return `(?:^|\\s)@(?:${keys.join('|')})(?=\\s|$)`;
}

/** A Jira issue link is not the Xray Test Plan relationship. Establish it explicitly. */
export async function linkExecutionToPlan(testPlanKey, testExecKey, token) {
  validateKey(testPlanKey); validateKey(testExecKey);
  const data = await graphql(`query ResolveIssues($plan: String!, $execution: String!) {
    getTestPlans(jql: $plan, limit: 1) { total results { issueId } }
    getTestExecutions(jql: $execution, limit: 1) { total results { issueId } }
  }`, { plan: `key = "${testPlanKey}"`, execution: `key = "${testExecKey}"` }, token);
  const ids = ['getTestPlans', 'getTestExecutions'].map(field => {
    const group = data[field];
    if (group?.total !== 1 || group.results?.length !== 1 || !/^\d+$/.test(group.results[0].issueId)) {
      throw new Error('Plan or Execution is not visible/indexed in Xray; retry after checking its issue type.');
    }
    return group.results[0].issueId;
  });
  const linked = await graphql(`mutation LinkExecution($plan: String!, $executions: [String]!) {
    addTestExecutionsToTestPlan(issueId: $plan, testExecIssueIds: $executions) { addedTestExecutions warning }
  }`, { plan: ids[0], executions: [ids[1]] }, token, false);
  const result = linked.addTestExecutionsToTestPlan;
  if (!result) throw new Error('Xray returned no association result.');
  // A repeated dispatch may find the association already present. Verify membership
  // instead of assuming every mutation warning is either success or failure.
  if (!result.addedTestExecutions?.includes(ids[1]) || result.warning?.length) {
    let start = 0;
    let found = false;
    do {
      const check = await graphql(`query Association($id: String!, $start: Int!) {
        getTestExecution(issueId: $id) { testPlans(limit: 100, start: $start) {
          total start results { issueId }
        } }
      }`, { id: ids[1], start }, token);
      const page = check.getTestExecution?.testPlans;
      if (!page || !Number.isInteger(page.total) || page.start !== start || !Array.isArray(page.results)) break;
      found = page.results.some(plan => plan.issueId === ids[0]);
      if (found || !page.results.length) break;
      start += page.results.length;
      if (start >= page.total) break;
    } while (start < 100_000);
    if (!found) throw new Error('Xray could not confirm linking the Execution to the Plan. Check association in Xray.');
  }
  console.log(`Linked ${testExecKey} to Xray Test Plan ${testPlanKey}.`);
}

async function readNonemptyFile(path, maxBytes) {
  const info = await stat(path);
  if (!info.isFile() || info.size === 0 || info.size > maxBytes) throw new Error(`Missing, empty or oversized report: ${path}`);
  return readFile(path);
}

export async function importResultsToXray(testExecKey, xmlReportPath, token) {
  validateKey(testExecKey);
  const xml = await readNonemptyFile(xmlReportPath, 50 * 1024 * 1024);
  // Structural checks catch empty/setup-only reports; Xray performs full XML validation.
  if (!/<testcase[\s>]/.test(xml.toString('utf8'))) throw new Error('JUnit report has no test cases; import refused.');
  const result = await requestJson(`${XRAY}/import/execution/junit?testExecKey=${encodeURIComponent(testExecKey)}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/xml' }, body: xml,
  }, { label: 'Xray JUnit import' });
  if (result?.key !== testExecKey) throw new Error('Xray import did not confirm the requested Test Execution. Inspect it before retrying.');
  console.log(`Imported JUnit results into ${testExecKey}.`);
  return result;
}

export function jiraBaseUrl(domain) {
  if (typeof domain !== 'string' || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.atlassian\.net)?$/i.test(domain)) {
    throw new Error('JIRA_DOMAIN must be a tenant name or tenant.atlassian.net, without scheme or path.');
  }
  return `https://${domain.includes('.') ? domain : `${domain}.atlassian.net`}`;
}

export async function uploadReportToJira(testExecKey, htmlPath, jiraDomain, jiraEmail, jiraToken) {
  validateKey(testExecKey);
  const base = jiraBaseUrl(jiraDomain);
  if (!jiraEmail?.trim() || !jiraToken?.trim()) throw new Error('Missing Jira email or API token.');
  const bytes = await readNonemptyFile(htmlPath, 100 * 1024 * 1024);
  if (!/<html(?:\s|>)/i.test(bytes.toString('utf8'))) throw new Error('Report is not an HTML document.');
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'text/html' }), 'index.html');
  const result = await requestJson(`${base}/rest/api/3/issue/${testExecKey}/attachments`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${jiraEmail}:${jiraToken}`).toString('base64')}`,
      Accept: 'application/json', 'X-Atlassian-Token': 'no-check',
    },
    // Native fetch supplies the multipart boundary; do not set Content-Type manually.
    body: form,
  }, { label: 'Jira attachment upload' });
  if (!Array.isArray(result) || !result.some(item => item.id && item.filename === 'index.html')) {
    throw new Error('Jira did not confirm the attachment. Inspect the issue before retrying.');
  }
  console.log(`Attached index.html to ${testExecKey}.`);
  return result;
}

/** Validate the list reporter output before any browser runs. All selected keys must
 * map one-to-one to cases, including the static annotation used by the JUnit reporter.
 */
export function validateSelection(report, keys) {
  if (report.errors?.length) throw new Error('Playwright discovery reported errors.');
  const counts = new Map(keys.map(key => [key, 0]));
  function visit(suites) {
    for (const suite of suites ?? []) {
      for (const spec of suite.specs ?? []) {
        // The pinned JSON reporter removes the leading @ from tag values.
        const tags = (spec.tags ?? []).map(tag => tag.replace(/^@/, '')).filter(tag => KEY.test(tag));
        if (tags.length !== 1 || !counts.has(tags[0])) throw new Error('Every selected case must have exactly one selected Jira Test tag.');
        const key = tags[0];
        for (const test of spec.tests ?? []) {
          const annotations = (test.annotations ?? []).filter(a => a.type === 'test_key');
          if (annotations.length !== 1 || annotations[0].description !== key) throw new Error(`Missing/mismatched static test_key annotation for ${key}. Use the xray() helper.`);
          counts.set(key, counts.get(key) + 1);
        }
      }
      visit(suite.suites);
    }
  }
  visit(report.suites);
  for (const [key, count] of counts) if (count !== 1) throw new Error(`${key} matched ${count} cases; expected exactly one Chromium case.`);
}

export async function main(command = process.argv[2]) {
  if (command === 'validate') {
    validateKey(required('TEST_PLAN_KEY'), 'Test Plan key');
    validateKey(required('TEST_EXEC_KEY'), 'Test Execution key');
    console.log('Dispatch keys validated.');
  } else if (command === 'select') {
    const plan = validateKey(required('TEST_PLAN_KEY'));
    const execution = validateKey(required('TEST_EXEC_KEY'));
    const token = await authenticateXray();
    const keys = await fetchTestKeys(plan, token);
    await linkExecutionToPlan(plan, execution, token);
    const grep = buildGrepFilter(keys);
    await mkdir(dirname(STATE), { recursive: true });
    await writeFile(STATE, JSON.stringify({ plan, execution, keys, grep }, null, 2));
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `grep=${grep}\n`);
  } else if (command === 'run') {
    const selection = JSON.parse(await readFile(STATE, 'utf8'));
    if (selection.plan !== required('TEST_PLAN_KEY') || selection.execution !== required('TEST_EXEC_KEY')) throw new Error('Selection belongs to a different dispatch.');
    const grep = buildGrepFilter(selection.keys);
    const cwd = resolve(process.env.SOURCE_DIR ?? 'tcoe-playwright-repo');
    const cli = resolve(cwd, 'node_modules/@playwright/test/cli.js');
    const args = [cli, 'test', '--project=chromium', '--grep', grep];
    // Existing source frameworks can disable retries specifically for Xray runs.
    const runEnv = { ...process.env, XRAY_RUN: 'true' };
    // Avoid shell interpolation, npx downloads and OS-specific command quoting.
    const discovery = spawnSync(process.execPath, [...args, '--list', '--reporter=json'], {
      cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
      env: { ...runEnv, PLAYWRIGHT_JSON_OUTPUT_FILE: '', PLAYWRIGHT_JSON_OUTPUT_NAME: '' },
    });
    if (discovery.error || discovery.status !== 0) throw new Error('Playwright discovery failed. Check source configuration and dependencies.');
    validateSelection(JSON.parse(discovery.stdout), selection.keys);
    const run = spawnSync(process.execPath, args, { cwd, stdio: 'inherit', env: runEnv });
    if (run.error) throw new Error('Could not start Playwright.');
    process.exitCode = run.status ?? 1;
  } else if (command === 'import') {
    const token = await authenticateXray();
    await importResultsToXray(required('TEST_EXEC_KEY'), process.env.XML_REPORT_PATH ?? 'tcoe-playwright-repo/results/xray-results.xml', token);
  } else if (command === 'attach') {
    await uploadReportToJira(required('TEST_EXEC_KEY'), process.env.HTML_REPORT_PATH ?? 'tcoe-playwright-repo/TCOE-Report/index.html',
      required('JIRA_DOMAIN'), required('JIRA_USER_EMAIL'), required('JIRA_API_TOKEN'));
  } else {
    throw new Error('Usage: node scripts/xray-orchestrator.js <validate|select|run|import|attach>');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Orchestration failed: ${error.message}`); process.exitCode = 1; });
}
