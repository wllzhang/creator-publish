#!/usr/bin/env node
/**
 * Unified creator-publish entry.
 *
 *   node runtime/run.mjs --platform <id> [platform fields...]
 *
 * Routes:
 *   douyin | bilibili | weixin_channels | xiaohongshu  → write_job + Ego social
 *   fanqie_short | ximalaya_audio | kdp_ebook          → novel/*_publish.mjs
 *   wechat_mp                                          → wechat/wechat_mp_draft.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseArgs, need } from './lib/cli_args.mjs';
import { runEgoMjs, tmpJoin } from './lib/ego_util.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const SOCIAL = {
  douyin: 'social/douyin_draft.mjs',
  bilibili: 'social/bilibili_draft.mjs',
  weixin_channels: 'social/channels_draft.mjs',
  xiaohongshu: 'social/xhs_draft.mjs',
};

const NOVEL = {
  fanqie_short: 'novel/fanqie_publish.mjs',
  ximalaya_audio: 'novel/ximalaya_publish.mjs',
  kdp_ebook: 'novel/kdp_publish.mjs',
};

const ALL = new Set([...Object.keys(SOCIAL), ...Object.keys(NOVEL), 'wechat_mp']);

function forwardArgv(argv = process.argv.slice(2)) {
  // Drop --platform <value> so child CLIs that don't expect it stay clean.
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--platform') {
      i++;
      continue;
    }
    if (a.startsWith('--platform=')) continue;
    out.push(a);
  }
  return out;
}

function runNode(scriptAbs, args, { env, timeoutMs } = {}) {
  const r = spawnSync(process.execPath, [scriptAbs, ...args], {
    encoding: 'utf8',
    stdio: 'inherit',
    env: env ? { ...process.env, ...env } : process.env,
    timeout: timeoutMs,
  });
  if (r.error) {
    console.error(r.error.message);
    return 1;
  }
  return r.status ?? 1;
}

const args = parseArgs();
const platform = need(args, 'platform');
if (!ALL.has(platform)) {
  console.error('unknown --platform', platform);
  console.error('supported:', [...ALL].join(', '));
  process.exit(2);
}

const forwarded = forwardArgv();

if (SOCIAL[platform]) {
  const jobOut = path.resolve(args.out || tmpJoin(`creator-publish-${platform}-job.json`));
  const writeArgs = forwarded.filter((a, i, arr) => {
    if (a === '--out') return false;
    if (i > 0 && arr[i - 1] === '--out') return false;
    return true;
  });
  writeArgs.push('--platform', platform, '--out', jobOut);
  const w = runNode(path.join(HERE, 'write_job.mjs'), writeArgs);
  if (w !== 0) process.exit(w);
  process.exit(
    runEgoMjs(path.join(HERE, SOCIAL[platform]), {
      timeoutMs: 900_000,
      env: { CREATOR_PUBLISH_JOB: jobOut },
    }),
  );
}

if (NOVEL[platform]) {
  process.exit(runNode(path.join(HERE, NOVEL[platform]), forwarded, { timeoutMs: 3_600_000 }));
}

// wechat_mp
process.exit(
  runNode(path.join(HERE, 'wechat/wechat_mp_draft.mjs'), forwarded, { timeoutMs: 600_000 }),
);
