#!/usr/bin/env node
/**
 * Backward-compatible alias → runtime/run.mjs (social platforms only).
 * Prefer: node runtime/run.mjs --platform <douyin|bilibili|weixin_channels|xiaohongshu> ...
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseArgs, need } from './lib/cli_args.mjs';

const SOCIAL = new Set(['douyin', 'bilibili', 'weixin_channels', 'xiaohongshu']);
const args = parseArgs();
const platform = need(args, 'platform');
if (!SOCIAL.has(platform)) {
  console.error('run_social only supports:', [...SOCIAL].join(', '));
  console.error('use: node runtime/run.mjs --platform', platform, '...');
  process.exit(2);
}

const run = path.join(path.dirname(fileURLToPath(import.meta.url)), 'run.mjs');
const r = spawnSync(process.execPath, [run, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status ?? 1);
