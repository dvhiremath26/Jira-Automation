import { readFile, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const KEY = /^[A-Z][A-Z0-9_]*-[1-9]\d*$/;

export function validateKey(value, label = 'issue key') {
  if (typeof value !== 'string' || !KEY.test(value) || value.length > 100) {
    throw new Error(`Invalid ${label}; expected an uppercase Jira key such as PROJ-101.`);
  }
  return value;
}

export function required(name) {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`Missing environment variable ${name}.`);
  return value;
}

/** Bounded timeouts; retries only for read/auth operations, never ambiguous writes.
 * Response bodies are deliberately excluded from errors to avoid leaking credentials.
 */
export async function requestJson(url, options, { label, retry = false, allowEmpty = false } = {}) {
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
    if (allowEmpty && !body.trim()) return null;
    try { return JSON.parse(body); } catch { throw new Error(`${label}: expected a JSON response.`); }
  }
}

export async function readNonemptyFile(path, maxBytes) {
  const info = await stat(path);
  if (!info.isFile() || info.size === 0 || info.size > maxBytes) throw new Error(`Missing, empty or oversized report: ${path}`);
  return readFile(path);
}
