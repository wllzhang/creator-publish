#!/usr/bin/env node
/**
 * Remote Ego Bridge Dispatcher & Offline Queue (Zero Playwright).
 *
 * Used from Linux/Muse to dispatch browser-platform jobs (`douyin`, `bilibili`,
 * `weixin_channels`, `xiaohongshu`, `fanqie_short`, `ximalaya_audio`, `kdp_ebook`,
 * `gmail`) to the Windows desktop bridge (`http://100.113.147.88:18880`), or
 * persist an offline queue bundle under `/home/hatch/work/publish_queue/` when
 * the Windows PC is offline.
 *
 * Subcommands / modes:
 *   node runtime/remote_ego_dispatch.mjs --platform <id> --profile-id "<id>" [fields...] [--check] [--enqueue]
 *   node runtime/remote_ego_dispatch.mjs --list-queue [--queue-dir <dir>]
 *   node runtime/remote_ego_dispatch.mjs --flush-queue [--queue-dir <dir>]
 */
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, need } from './lib/cli_args.mjs';

const SOCIAL_DRAFT_ONLY = new Set([
  'douyin',
  'bilibili',
  'weixin_channels',
  'xiaohongshu',
  'wechat_mp',
  'x',
  'youtube',
]);

const FILE_LIST_FLAGS = new Set(['images', 'body-images', 'attachments']);
const FILE_SINGLE_FLAGS = new Set(['video', 'cover', 'mp3', 'epub', 'body-file', 'html-file', 'intro-file', 'api-env']);

function loadEnvFile(filePath) {
  const out = {};
  if (!fs.existsSync(filePath)) return out;
  for (const raw of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

export function resolveBridgeConfig(bridgeEnvPath) {
  const p = bridgeEnvPath
    ? path.resolve(bridgeEnvPath)
    : path.join(os.homedir(), '.secrets', 'local_bridge.env');
  const fe = loadEnvFile(p);
  const host = process.env.LOCAL_BRIDGE_HOST || fe.LOCAL_BRIDGE_HOST || '100.113.147.88';
  const port = Number(process.env.LOCAL_BRIDGE_PORT || fe.LOCAL_BRIDGE_PORT || 18880);
  const token = String(process.env.LOCAL_BRIDGE_TOKEN || fe.LOCAL_BRIDGE_TOKEN || '').trim();
  return { host, port, token, baseUrl: `http://${host}:${port}` };
}

export function resolveTailscaleProxyUrl() {
  const override = String(process.env.MUSE_TAILSCALE_PROXY || '').trim();
  if (override) return new URL(override);
  if (process.platform === 'win32') return null;
  for (const k of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
    const raw = String(process.env[k] || '').trim();
    if (!raw) continue;
    try {
      const u = new URL(raw);
      if (u.hostname === 'hatch-egress-proxy') {
        u.port = '3130';
        return u;
      }
    } catch {
      /* ignore invalid proxy env */
    }
  }
  return null;
}

export function defaultQueueDir(explicitDir) {
  if (explicitDir) return path.resolve(explicitDir);
  if (process.platform !== 'win32' && fs.existsSync('/home/hatch')) {
    return '/home/hatch/work/publish_queue';
  }
  return path.join(process.env.TEMP || process.env.TMP || os.tmpdir(), 'creator-publish-queue');
}

function httpRequest({ urlStr, method = 'GET', headers = {}, body = null, timeoutMs = 5000 }) {
  return new Promise((resolve, reject) => {
    const target = new URL(urlStr);
    const proxy = resolveTailscaleProxyUrl();
    const isHttps = target.protocol === 'https:';
    let reqOpts;
    let client = isHttps ? https : http;

    if (proxy && !isHttps) {
      const hdrs = { Host: target.host, ...headers };
      if (proxy.username || proxy.password) {
        const auth = Buffer.from(
          `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`,
        ).toString('base64');
        hdrs['Proxy-Authorization'] = `Basic ${auth}`;
      }
      client = http;
      reqOpts = {
        hostname: proxy.hostname,
        port: Number(proxy.port) || 3130,
        method,
        path: urlStr,
        headers: hdrs,
        timeout: timeoutMs,
      };
    } else {
      reqOpts = {
        hostname: target.hostname,
        port: Number(target.port) || (isHttps ? 443 : 80),
        method,
        path: `${target.pathname}${target.search}`,
        headers,
        timeout: timeoutMs,
      };
    }

    const req = client.request(reqOpts, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = { raw };
        }
        resolve({ status: res.statusCode || 0, data: parsed });
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error(`HTTP timeout after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function checkBridgeHealth(cfg, timeoutMs = 2500) {
  if (!cfg.token) return { online: false, reason: 'missing LOCAL_BRIDGE_TOKEN' };
  try {
    const res = await httpRequest({
      urlStr: `${cfg.baseUrl}/health`,
      method: 'GET',
      headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/json' },
      timeoutMs,
    });
    return {
      online: res.status === 200 && res.data?.status === 'ok',
      status: res.status,
      health: res.data,
    };
  } catch (err) {
    return { online: false, reason: err.message };
  }
}

function stripInternalArgs(argv = process.argv.slice(2)) {
  const dropWithVal = new Set(['--platform', '--profile-id', '--bridge-env', '--queue-dir', '--mode']);
  const dropFlags = new Set(['--enqueue', '--no-queue', '--list-queue', '--flush-queue', '--submit', '--require-online']);
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (dropFlags.has(a)) continue;
    const eq = a.indexOf('=');
    const key = eq === -1 ? a : a.slice(0, eq);
    if (dropWithVal.has(key)) {
      if (eq === -1 && i + 1 < argv.length && !argv[i + 1].startsWith('--')) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

function collectFileArgs(rawArgs) {
  const uploads = [];
  const cleanArgs = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i];
    if (!a.startsWith('--')) {
      cleanArgs.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const flagName = eq === -1 ? a.slice(2) : a.slice(2, eq);
    const val = eq === -1 ? (i + 1 < rawArgs.length && !rawArgs[i + 1].startsWith('--') ? rawArgs[++i] : null) : a.slice(eq + 1);
    if (val != null && (FILE_SINGLE_FLAGS.has(flagName) || FILE_LIST_FLAGS.has(flagName))) {
      const files = FILE_LIST_FLAGS.has(flagName)
        ? val.split(',').map((s) => s.trim()).filter(Boolean)
        : [val.trim()];
      for (const f of files) {
        const abs = path.resolve(f);
        if (!fs.existsSync(abs)) {
          throw new Error(`Input file not found for --${flagName}: ${abs}`);
        }
      }
      uploads.push({ flag: `--${flagName}`, files: files.map((f) => path.resolve(f)), multi: FILE_LIST_FLAGS.has(flagName) });
    } else {
      cleanArgs.push(`--${flagName}`);
      if (val != null) cleanArgs.push(val);
    }
  }
  return { uploads, cleanArgs };
}

async function uploadAndDispatch(cfg, { jobId, platform, profileId, mode, uploads, cleanArgs, timeoutSec = 600 }) {
  const finalArgs = [...cleanArgs];
  for (const u of uploads) {
    const staged = [];
    for (const f of u.files) {
      const buf = fs.readFileSync(f);
      const res = await httpRequest({
        urlStr: `${cfg.baseUrl}/upload`,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(buf.length),
          'X-Job-Id': jobId,
          'X-Filename': path.basename(f),
        },
        body: buf,
        timeoutMs: 300_000,
      });
      if (res.status !== 200 || !res.data?.ok) {
        throw new Error(`Bridge upload failed for ${path.basename(f)}: ${JSON.stringify(res.data)}`);
      }
      staged.push(res.data.path);
    }
    finalArgs.push(u.flag, u.multi ? staged.join(',') : staged[0]);
  }

  const startBody = JSON.stringify({
    job_id: jobId,
    platform,
    profile_id: profileId,
    mode,
    args: finalArgs,
    timeout_sec: timeoutSec,
    async: true,
  });
  const start = await httpRequest({
    urlStr: `${cfg.baseUrl}/publish/run`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(Buffer.byteLength(startBody)),
    },
    body: startBody,
    timeoutMs: 15_000,
  });
  if (start.status !== 200 && start.status !== 202) {
    throw new Error(`Bridge /publish/run rejected (${start.status}): ${JSON.stringify(start.data)}`);
  }
  if (start.status === 200) return start.data;

  const deadline = Date.now() + (timeoutSec + 30) * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2500));
    const poll = await httpRequest({
      urlStr: `${cfg.baseUrl}/jobs/${encodeURIComponent(jobId)}`,
      method: 'GET',
      headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/json' },
      timeoutMs: 10_000,
    });
    if (poll.status === 200 && poll.data?.status !== 'running' && poll.data?.status !== 'queued') {
      return poll.data;
    }
  }
  throw new Error(`Timed out waiting for bridge job ${jobId}`);
}

function enqueueJob(queueRoot, { jobId, platform, profileId, mode, uploads, cleanArgs }) {
  const jobDir = path.join(queueRoot, jobId);
  const assetsDir = path.join(jobDir, 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });
  const queuedUploads = [];
  for (const u of uploads) {
    const copied = [];
    for (const src of u.files) {
      const base = path.basename(src);
      let dest = path.join(assetsDir, base);
      if (fs.existsSync(dest)) {
        dest = path.join(assetsDir, `${Date.now()}_${base}`);
      }
      fs.copyFileSync(src, dest);
      copied.push(dest);
    }
    queuedUploads.push({ flag: u.flag, files: copied, multi: u.multi });
  }
  const spec = {
    job_id: jobId,
    created_at: new Date().toISOString(),
    status: 'queued',
    platform,
    profile_id: profileId,
    mode,
    uploads: queuedUploads,
    clean_args: cleanArgs,
  };
  const jobFile = path.join(jobDir, 'job.json');
  fs.writeFileSync(jobFile, JSON.stringify(spec, null, 2) + '\n', 'utf8');
  return { jobDir, jobFile, spec };
}

function listQueue(queueRoot) {
  if (!fs.existsSync(queueRoot)) return [];
  const items = [];
  for (const name of fs.readdirSync(queueRoot).sort()) {
    const jf = path.join(queueRoot, name, 'job.json');
    if (!fs.existsSync(jf)) continue;
    try {
      const obj = JSON.parse(fs.readFileSync(jf, 'utf8'));
      items.push({ dir: path.join(queueRoot, name), ...obj });
    } catch {
      /* ignore corrupt entry */
    }
  }
  return items;
}

async function main() {
  const args = parseArgs();
  const cfg = resolveBridgeConfig(args['bridge-env']);
  const queueRoot = defaultQueueDir(args['queue-dir']);

  if (args['list-queue']) {
    console.log(JSON.stringify({ queue_root: queueRoot, items: listQueue(queueRoot) }, null, 2));
    return;
  }

  if (args['flush-queue']) {
    const health = await checkBridgeHealth(cfg);
    if (!health.online) {
      console.error(JSON.stringify({ ok: false, error: 'Bridge offline; cannot flush queue', health }, null, 2));
      process.exit(10);
    }
    const pending = listQueue(queueRoot).filter((it) => it.status === 'queued');
    const results = [];
    for (const it of pending) {
      try {
        const res = await uploadAndDispatch(cfg, {
          jobId: it.job_id,
          platform: it.platform,
          profileId: it.profile_id,
          mode: it.mode,
          uploads: it.uploads || [],
          cleanArgs: it.clean_args || [],
        });
        const jf = path.join(it.dir, 'job.json');
        fs.writeFileSync(jf, JSON.stringify({ ...it, status: res.exit_code === 0 ? 'completed' : 'failed', result: res }, null, 2) + '\n', 'utf8');
        results.push({ job_id: it.job_id, status: res.status, exit_code: res.exit_code });
      } catch (err) {
        results.push({ job_id: it.job_id, status: 'error', error: err.message });
      }
    }
    console.log(JSON.stringify({ ok: true, flushed: results.length, results }, null, 2));
    return;
  }

  const platform = need(args, 'platform');
  const profileId = need(args, 'profile-id');
  const rawMode = args.mode ? String(args.mode).toLowerCase() : (args.submit ? 'submit' : 'draft');

  if (SOCIAL_DRAFT_ONLY.has(platform) && rawMode === 'submit') {
    console.error(`Draft-only safety gate blocks submit on social platform '${platform}'`);
    process.exit(2);
  }
  const mode = SOCIAL_DRAFT_ONLY.has(platform) ? 'draft' : rawMode;
  const { uploads, cleanArgs } = collectFileArgs(stripInternalArgs());
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jobId = `cp_${stamp}_${platform}`;

  if (args.check) {
    const health = await checkBridgeHealth(cfg);
    console.log(
      JSON.stringify(
        {
          ok: true,
          check_only: true,
          platform,
          profile_id: profileId,
          mode,
          bridge_online: health.online,
          bridge_host: cfg.baseUrl,
          uploads: uploads.map((u) => ({ flag: u.flag, count: u.files.length })),
          clean_args: cleanArgs,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (args.enqueue) {
    const q = enqueueJob(queueRoot, { jobId, platform, profileId, mode, uploads, cleanArgs });
    console.log(JSON.stringify({ ok: true, status: 'QUEUED_OFFLINE', job_id: jobId, job_file: q.jobFile }, null, 2));
    return;
  }

  const health = await checkBridgeHealth(cfg);
  if (!health.online) {
    if (args['no-queue']) {
      console.error(JSON.stringify({ ok: false, status: 'BRIDGE_OFFLINE', reason: health.reason || health }, null, 2));
      process.exit(10);
    }
    const q = enqueueJob(queueRoot, { jobId, platform, profileId, mode, uploads, cleanArgs });
    console.log(JSON.stringify({ ok: true, status: 'QUEUED_OFFLINE', reason: health.reason || 'bridge offline', job_id: jobId, job_file: q.jobFile }, null, 2));
    return;
  }

  const res = await uploadAndDispatch(cfg, { jobId, platform, profileId, mode, uploads, cleanArgs });
  console.log(JSON.stringify(res, null, 2));
  process.exit(res.exit_code ?? 1);
}

main().catch((err) => {
  console.error('[remote_ego_dispatch]', err.message);
  process.exit(1);
});
