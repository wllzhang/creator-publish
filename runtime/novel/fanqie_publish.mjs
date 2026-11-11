#!/usr/bin/env node
/** Fanqie: --profile-id --title --body|--body-file --cover [--category] [--submit] [--check] */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, need } from '../lib/cli_args.mjs';
import { runEgoMjs, tmpJoin } from '../lib/ego_util.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MJS = path.join(HERE, 'fanqie_ego.mjs');
const TITLE_MAX = 15;

function cleanMarkdownBody(text) {
  let body = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  body = body.replace(/^#{1,6}\s+/gm, '');
  body = body.replace(/\*\*(.+?)\*\*/g, '$1');
  return body.trim();
}

function readBody(args) {
  if (args['body-file']) return fs.readFileSync(path.resolve(args['body-file']), 'utf8');
  if (args.body) return String(args.body);
  throw new Error('need --body or --body-file');
}

const args = parseArgs();
const profileId = need(args, 'profile-id');
const title = need(args, 'title');
const cover = path.resolve(need(args, 'cover'));
if (!fs.existsSync(cover)) {
  console.error('cover not found:', cover);
  process.exit(2);
}
const hanzi = (title.match(/[\u4e00-\u9fa5]/g) || []).length;
if (hanzi > TITLE_MAX) {
  console.error(`title hanzi ${hanzi} > ${TITLE_MAX}: ${title}`);
  process.exit(2);
}
let body;
try {
  body = cleanMarkdownBody(readBody(args));
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
const category = args.category || '都市日常';
const plan = { title, body, category, cover: cover.replace(/\\/g, '/') };
console.log(JSON.stringify({ ...plan, body: plan.body.slice(0, 60) + '…' }, null, 2));
if (args.check) process.exit(0);

const runPath = tmpJoin('creator-publish-fanqie-run.json');
const resultPath = tmpJoin('creator-publish-fanqie-result.json');
const cfg = {
  space_name: 'fanqie-pub-' + new Date().toISOString().replace(/[:.]/g, '-'),
  profileId,
  title: plan.title,
  body: plan.body,
  category: plan.category,
  cover: plan.cover,
  trial: Number(args.trial || 99),
  ai: !args['no-ai'],
  submit: !!args.submit,
};
fs.writeFileSync(runPath, JSON.stringify(cfg, null, 2), 'utf8');
try { fs.unlinkSync(resultPath); } catch { /* ok */ }
process.env.CREATOR_PUBLISH_RUN = runPath;
process.env.CREATOR_PUBLISH_RESULT = resultPath;
const code = runEgoMjs(MJS, { timeoutMs: 600_000 });
if (fs.existsSync(resultPath)) console.log(fs.readFileSync(resultPath, 'utf8'));
process.exit(code);
