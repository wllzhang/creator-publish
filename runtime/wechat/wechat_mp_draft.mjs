#!/usr/bin/env node
/**
 * WeChat MP draft via official API (Node only).
 *
 * Egress (first hit wins):
 *   1) --egress
 *   2) process env WECHAT_MP_EGRESS
 *   3) api-env WECHAT_MP_EGRESS          (local | user@host)
 *   4) api-env WECHAT_MP_EGRESS_SSH      (user@host)
 *   5) api-env WECHAT_MP_EGRESS_IP set   → SSH (requires WECHAT_MP_EGRESS_SSH or WECHAT_MP_EGRESS)
 *   6) else local
 *
 * SSH mode scp's api_draft.mjs and runs `node` on the whitelist host (no local VPN).
 * Local mode runs the same api_draft.mjs with proxy env cleared.
 *
 * Required: --api-env --title --html-file|--html --cover
 * Optional: --body-images --digest --author --egress --out
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseArgs, need } from '../lib/cli_args.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_DRAFT = path.join(__dirname, 'api_draft.mjs');
const FALLBACK_SSH = '';

function loadEnvFile(filePath) {
  const out = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const i = t.indexOf('=');
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

/** @returns {{ mode: 'local'|'ssh', target: string, source: string }} */
function resolveEgress(cliEgress, fileEnv) {
  const candidates = [
    ['--egress', cliEgress],
    ['env WECHAT_MP_EGRESS', process.env.WECHAT_MP_EGRESS],
    ['api-env WECHAT_MP_EGRESS', fileEnv.WECHAT_MP_EGRESS],
    ['api-env WECHAT_MP_EGRESS_SSH', fileEnv.WECHAT_MP_EGRESS_SSH],
  ];
  for (const [source, raw] of candidates) {
    const v = String(raw || '').trim();
    if (!v) continue;
    if (v.toLowerCase() === 'local') return { mode: 'local', target: 'local', source };
    return { mode: 'ssh', target: v, source };
  }
  if (String(fileEnv.WECHAT_MP_EGRESS_IP || '').trim()) {
    const host = String(fileEnv.WECHAT_MP_EGRESS_SSH || FALLBACK_SSH).trim();
    if (!host) {
      throw new Error(
        'WECHAT_MP_EGRESS_IP is set but no SSH host: set WECHAT_MP_EGRESS / WECHAT_MP_EGRESS_SSH or --egress user@host',
      );
    }
    return {
      mode: 'ssh',
      target: host,
      source: 'api-env WECHAT_MP_EGRESS_IP (+ EGRESS_SSH/EGRESS)',
    };
  }
  return { mode: 'local', target: 'local', source: 'default local' };
}

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
  if (r.error) throw r.error;
  return r;
}

function mustOk(r, label) {
  if (r.status !== 0) {
    const err = (r.stderr || r.stdout || '').trim();
    throw new Error(`${label} failed (exit ${r.status}): ${err.slice(0, 800)}`);
  }
  return r;
}

function sshBase(host) {
  return ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', host];
}

function clearProxyEnv(env = process.env) {
  const out = { ...env };
  for (const k of Object.keys(out)) {
    if (/^(https?|all|no)_proxy$/i.test(k)) delete out[k];
  }
  return out;
}

function writeTempHtml(html) {
  const p = path.join(os.tmpdir(), `creator-publish-wechat-${Date.now()}.html`);
  fs.writeFileSync(p, html, 'utf8');
  return p;
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function buildApiArgs({ apiEnv, title, htmlFile, cover, bodyImages, digest, author, out }) {
  const args = [
    API_DRAFT,
    '--api-env', apiEnv,
    '--title', title,
    '--html-file', htmlFile,
    '--cover', cover,
    '--out', out,
  ];
  if (bodyImages.length) args.push('--body-images', bodyImages.join(','));
  if (digest) args.push('--digest', digest);
  if (author) args.push('--author', author);
  return args;
}

function runLocalNode(common) {
  const node = process.env.WECHAT_MP_NODE || process.execPath || 'node';
  console.log(`[*] egress=local (${common.egressNote}); proxy env cleared for API child`);
  console.log('[*] require: calling IP allowlisted + DIRECT to api.weixin.qq.com (no VPN)');
  const r = spawnSync(node, buildApiArgs(common), {
    encoding: 'utf8',
    env: clearProxyEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0) process.exit(r.status || 1);
}

function runSshEgress({
  host, apiEnv, title, htmlFile, cover, bodyImages, digest, author, out, egressNote, expectIp,
}) {
  const stamp = Date.now().toString(16);
  const remoteBase = `/tmp/creator_publish_wechat_${stamp}`;
  const sshArgs = sshBase(host);
  const scpOpts = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15'];

  console.log(`[*] egress=ssh ${host} (${egressNote})`);
  if (expectIp) console.log(`[*] expected whitelist IP ${expectIp}`);

  mustOk(
    sh('ssh', [...sshArgs, `rm -rf ${remoteBase} && mkdir -p ${remoteBase}/imgs ${remoteBase}/secrets`]),
    'ssh mkdir',
  );
  mustOk(sh('scp', [...scpOpts, API_DRAFT, `${host}:${remoteBase}/api_draft.mjs`]), 'scp api_draft.mjs');
  mustOk(sh('scp', [...scpOpts, apiEnv, `${host}:${remoteBase}/secrets/wechat_mp.env`]), 'scp api-env');
  mustOk(sh('scp', [...scpOpts, htmlFile, `${host}:${remoteBase}/article.html`]), 'scp html');
  mustOk(sh('scp', [...scpOpts, cover, `${host}:${remoteBase}/cover${path.extname(cover) || '.jpg'}`]), 'scp cover');

  const remoteBody = [];
  for (const img of bodyImages) {
    const base = path.basename(img);
    mustOk(sh('scp', [...scpOpts, img, `${host}:${remoteBase}/imgs/${base}`]), `scp ${base}`);
    remoteBody.push(`${remoteBase}/imgs/${base}`);
  }

  const coverRemote = `${remoteBase}/cover${path.extname(cover) || '.jpg'}`;
  const remoteOut = `${remoteBase}/api_draft_result.json`;
  const nodeBin = process.env.WECHAT_MP_REMOTE_NODE || 'node';
  const cmdParts = [
    `command -v ${nodeBin} >/dev/null || { echo "missing ${nodeBin} on egress host; install Node.js"; exit 3; }`,
    `chmod 600 ${remoteBase}/secrets/wechat_mp.env`,
    `${nodeBin} ${remoteBase}/api_draft.mjs` +
      ` --api-env ${remoteBase}/secrets/wechat_mp.env` +
      ` --title ${shellQuote(title)}` +
      ` --html-file ${remoteBase}/article.html` +
      ` --cover ${coverRemote}` +
      ` --out ${remoteOut}` +
      (remoteBody.length ? ` --body-images ${shellQuote(remoteBody.join(','))}` : '') +
      (digest ? ` --digest ${shellQuote(digest)}` : '') +
      (author ? ` --author ${shellQuote(author)}` : ''),
    `ec=$?`,
    `shred -u ${remoteBase}/secrets/wechat_mp.env 2>/dev/null || rm -f ${remoteBase}/secrets/wechat_mp.env`,
    `exit $ec`,
  ];
  const run = sh('ssh', [...sshArgs, cmdParts.join('; ')]);
  if (run.stdout) process.stdout.write(run.stdout);
  if (run.stderr) process.stderr.write(run.stderr);
  if (run.status !== 0) {
    sh('ssh', [...sshArgs, `rm -rf ${remoteBase}`]);
    process.exit(run.status || 1);
  }

  mustOk(sh('scp', [...scpOpts, `${host}:${remoteOut}`, out]), 'scp result');
  sh('ssh', [...sshArgs, `rm -rf ${remoteBase}`]);
  console.log('WECHAT_MP_DRAFT_OK', JSON.parse(fs.readFileSync(out, 'utf8')).media_id);
}

const args = parseArgs();
const apiEnv = path.resolve(need(args, 'api-env'));
const title = need(args, 'title');
const cover = path.resolve(need(args, 'cover'));
const out = path.resolve(args.out || path.join(os.tmpdir(), 'creator-publish-wechat-result.json'));

if (!fs.existsSync(apiEnv)) {
  console.error('api-env not found:', apiEnv);
  process.exit(2);
}
if (!fs.existsSync(cover)) {
  console.error('cover not found:', cover);
  process.exit(2);
}
if (!fs.existsSync(API_DRAFT)) {
  console.error('missing api_draft.mjs next to this script');
  process.exit(2);
}

const fileEnv = loadEnvFile(apiEnv);
const resolved = resolveEgress(args.egress, fileEnv);
const expectIp = String(fileEnv.WECHAT_MP_EGRESS_IP || '').trim() || null;

let htmlFile;
let tmpHtml = null;
if (args['html-file']) {
  htmlFile = path.resolve(args['html-file']);
  if (!fs.existsSync(htmlFile)) {
    console.error('html-file not found:', htmlFile);
    process.exit(2);
  }
} else if (args.html) {
  tmpHtml = writeTempHtml(String(args.html));
  htmlFile = tmpHtml;
} else {
  console.error('need --html-file or --html');
  process.exit(2);
}

const bodyImages = String(args['body-images'] || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((p) => path.resolve(p));
for (const p of bodyImages) {
  if (!fs.existsSync(p)) {
    console.error('body image not found:', p);
    process.exit(2);
  }
}

const common = {
  apiEnv,
  title,
  htmlFile,
  cover,
  bodyImages,
  digest: args.digest || '',
  author: args.author || fileEnv.WECHAT_MP_AUTHOR || '',
  out,
  egressNote: resolved.source,
  expectIp,
};

try {
  if (resolved.mode === 'local') {
    if (expectIp) {
      console.warn(
        `[!] api-env has WECHAT_MP_EGRESS_IP=${expectIp} but egress resolved to local (${resolved.source}). ` +
          'Ensure this machine\'s public IP is that allowlisted address (DIRECT, no VPN).',
      );
    }
    runLocalNode(common);
  } else {
    runSshEgress({ host: resolved.target, ...common });
  }
} finally {
  if (tmpHtml) {
    try { fs.unlinkSync(tmpHtml); } catch { /* ignore */ }
  }
}
