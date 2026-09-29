import { validateKey, required, requestJson, readNonemptyFile } from './api-common.js';

export function deploymentMode() {
  const mode = process.env.JIRA_DEPLOYMENT || 'cloud';
  if (!['cloud', 'datacenter'].includes(mode)) throw new Error('JIRA_DEPLOYMENT must be cloud or datacenter.');
  return mode;
}

export function dataCenterBaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('JIRA_BASE_URL must be an absolute HTTPS URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('JIRA_BASE_URL must use HTTPS without credentials, query or fragment.');
  }
  return url.href.replace(/\/+$/, '');
}

export function createDataCenterClient() {
  const base = dataCenterBaseUrl(required('JIRA_BASE_URL'));
  const pat = required('JIRA_PAT');
  if (/\s/.test(pat)) throw new Error('JIRA_PAT must not contain whitespace.');
  const headers = { Authorization: `Bearer ${pat}`, Accept: 'application/json' };
  const call = (path, options = {}, retry = false, allowEmpty = false) => requestJson(`${base}${path}`, {
    ...options, headers: { ...headers, ...options.headers },
  }, { label: 'Xray/Jira Data Center', retry, allowEmpty });
  const planPath = plan => `/rest/raven/1.0/api/testplan/${validateKey(plan)}`;

  return {
    async fetchTestKeys(plan) {
      const keys = new Set();
      // Xray returns arrays without a total. Continue through short pages until
      // an empty page, since the server may cap page size below our requested 100.
      for (let page = 1; page <= 10_000; page++) {
        const items = await call(`${planPath(plan)}/test?limit=100&page=${page}`, {}, true);
        if (!Array.isArray(items)) throw new Error('Invalid Data Center Test list response.');
        if (!items.length) {
          if (!keys.size) throw new Error('Test Plan is empty; refusing to run the entire suite.');
          console.log(`Selected ${keys.size} Tests from ${plan}.`);
          return [...keys];
        }
        for (const item of items) {
          const key = validateKey(item?.key);
          if (keys.has(key)) throw new Error('Duplicate Data Center Test across pages; check pagination and plan changes.');
          keys.add(key);
        }
      }
      throw new Error('Data Center pagination exceeded its safety limit.');
    },

    async linkExecutionToPlan(plan, execution) {
      validateKey(execution);
      const path = `${planPath(plan)}/testexecution`;
      const contains = async () => {
        const items = await call(path, {}, true);
        if (!Array.isArray(items)) throw new Error('Invalid Data Center Execution list response.');
        return items.some(item => validateKey(item?.key) === execution);
      };
      if (!await contains()) {
        const errors = await call(path, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ add: [execution], addTestsToPlan: false }),
        }, false, true);
        if (errors !== null && (!Array.isArray(errors) || errors.length)) {
          throw new Error('Xray Data Center rejected the Plan association. Check issue types and permissions.');
        }
        if (!await contains()) throw new Error('Xray Data Center did not confirm the Plan association.');
      }
      console.log(`Linked ${execution} to Xray Test Plan ${plan}.`);
    },

    async importResultsToXray(execution, path) {
      validateKey(execution);
      const xml = await readNonemptyFile(path, 50 * 1024 * 1024);
      if (!/<testcase[\s>]/.test(xml.toString('utf8'))) throw new Error('JUnit report has no test cases; import refused.');
      const form = new FormData();
      form.append('file', new Blob([xml], { type: 'text/xml' }), 'xray-results.xml');
      const result = await call(`/rest/raven/1.0/import/execution/junit?testExecKey=${execution}`, {
        method: 'POST', body: form, headers: { 'X-Atlassian-Token': 'no-check' },
      });
      if (result?.testExecIssue?.key !== execution) throw new Error('Xray Data Center import did not confirm the requested Execution. Inspect it before retrying.');
      console.log(`Imported JUnit results into ${execution}.`);
      return result;
    },

    async uploadReportToJira(execution, path) {
      validateKey(execution);
      const bytes = await readNonemptyFile(path, 100 * 1024 * 1024);
      if (!/<html(?:\s|>)/i.test(bytes.toString('utf8'))) throw new Error('Report is not an HTML document.');
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: 'text/html' }), 'index.html');
      const result = await call(`/rest/api/2/issue/${execution}/attachments`, {
        method: 'POST', body: form, headers: { 'X-Atlassian-Token': 'no-check' },
      });
      if (!Array.isArray(result) || !result.some(item => item.id && item.filename === 'index.html')) {
        throw new Error('Jira Data Center did not confirm the attachment. Inspect the issue before retrying.');
      }
      console.log(`Attached index.html to ${execution}.`);
      return result;
    },
  };
}
