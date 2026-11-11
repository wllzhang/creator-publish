import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const PROXY_VARS = new Set([
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
]);

export function findEgoExe() {
  const direct = path.join(os.homedir(), '.local', 'share', 'ego', 'active_version_dir', 'ego-browser.exe');
  if (fs.existsSync(direct)) return direct;
  const which = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(which, ['ego-browser'], { encoding: 'utf8' });
  const line = (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  if (!line) return null;
  if (line.toLowerCase().endsWith('.exe')) return line;
  if (line.toLowerCase().endsWith('.cmd')) {
    try {
      const content = fs.readFileSync(line, 'utf8');
      const m = content.match(/"([^"]+ego-browser\.exe)"/);
      if (m && fs.existsSync(m[1])) return m[1];
    } catch {
      /* ignore */
    }
  }
  return line;
}

export function scrubbedEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const k of PROXY_VARS) delete env[k];
  return env;
}

/**
 * Run mjs via file:// import (relative imports OK; paths with spaces OK).
 * Ego's nodejs often drops host env — inject critical keys inside -e before import.
 */
export function runEgoMjs(mjsPath, { timeoutMs = 600_000, missingCode = 3, missingMsg, env } = {}) {
  const exe = findEgoExe();
  if (!exe) {
    console.error(missingMsg || 'ego-browser not found; start Ego Lite first');
    return missingCode;
  }
  const abs = path.resolve(mjsPath);
  if (!fs.existsSync(abs)) {
    console.error('mjs not found:', abs);
    return 2;
  }
  const fileUrl = pathToFileURL(abs).href;
  const inject = { ...env };
  // Also forward creator-publish keys already on process.env
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('CREATOR_PUBLISH_') && inject[k] === undefined) inject[k] = process.env[k];
  }
  const prelude = Object.entries(inject)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `process.env[${JSON.stringify(k)}]=${JSON.stringify(String(v))};`)
    .join('');
  const expr = `${prelude}await import(${JSON.stringify(fileUrl)})`;
  const r = spawnSync(exe, ['nodejs', '-e', expr], {
    env: scrubbedEnv(env || {}),
    timeout: timeoutMs,
    stdio: 'inherit',
  });
  if (r.error) {
    console.error(r.error.message);
    return 1;
  }
  return r.status ?? 1;
}

export function runEgoEval(jsExpr, { timeoutMs = 600_000, missingCode = 3, missingMsg } = {}) {
  const exe = findEgoExe();
  if (!exe) {
    console.error(missingMsg || 'ego-browser not found; start Ego Lite first');
    return missingCode;
  }
  const r = spawnSync(exe, ['nodejs', '-e', jsExpr], {
    env: scrubbedEnv(),
    timeout: timeoutMs,
    stdio: 'inherit',
  });
  if (r.error) {
    console.error(r.error.message);
    return 1;
  }
  return r.status ?? 1;
}

export function tmpJoin(...parts) {
  return path.join(process.env.TEMP || process.env.TMP || os.tmpdir(), ...parts);
}
