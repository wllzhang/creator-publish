#!/usr/bin/env node
/** KDP: --profile-id --epub --cover --title [metadata flags] [--ai-generated yes|no] [--result-file] [--submit] [--check] */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, need } from '../lib/cli_args.mjs';
import { findEgoExe, runEgoMjs, tmpJoin } from '../lib/ego_util.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MJS = path.join(HERE, 'kdp_ego.mjs');

function readDesc(args) {
  if (args['description-file']) return fs.readFileSync(path.resolve(args['description-file']), 'utf8');
  if (args['description-html']) return String(args['description-html']);
  return null;
}

const args = parseArgs();
const profileId = need(args, 'profile-id');
const epub = path.resolve(need(args, 'epub'));
const cover = path.resolve(need(args, 'cover'));
const title = need(args, 'title');
if (!fs.existsSync(epub)) {
  console.error('epub not found:', epub);
  process.exit(2);
}
if (!fs.existsSync(cover)) {
  console.error('cover not found:', cover);
  process.exit(2);
}

const rawAi = args['ai-generated'] !== undefined ? String(args['ai-generated']).trim().toLowerCase() : 'no';
if (rawAi !== 'yes' && rawAi !== 'no') {
  console.error('invalid --ai-generated (expected yes|no):', args['ai-generated']);
  process.exit(2);
}

const desc = readDesc(args) || `<p>${title}</p>`;
const keywords = String(args.keywords || '')
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);

const resultPath = args['result-file']
  ? path.resolve(args['result-file'])
  : tmpJoin('creator-publish-kdp-result.json');

const cfg = {
  space_name: `kdp-pub-${process.pid}-${Date.now()}`,
  profileId,
  profile_id: profileId,
  title,
  subtitle: args.subtitle || '',
  author_first: args['author-first'] || 'Author',
  author_last: args['author-last'] || 'Name',
  description_html: desc,
  keywords,
  epub_file: epub.replace(/\\/g, '/'),
  cover_file: cover.replace(/\\/g, '/'),
  list_price: args['list-price'] ? Number(args['list-price']) : 3.99,
  ai_generated: rawAi,
  submit: !!args.submit,
  result_file: resultPath,
};
console.log(JSON.stringify({ ...cfg, description_html: undefined }, null, 2));
if (args.check) process.exit(0);
if (!findEgoExe()) {
  console.error('ego-browser not found');
  process.exit(3);
}
const runPath = tmpJoin(`creator-publish-kdp-run-${process.pid}-${Date.now()}.json`);
fs.mkdirSync(path.dirname(resultPath), { recursive: true });
fs.writeFileSync(runPath, JSON.stringify(cfg, null, 2), 'utf8');
try { fs.unlinkSync(resultPath); } catch { /* ok */ }
process.env.CREATOR_PUBLISH_RUN = runPath;
process.env.CREATOR_PUBLISH_RESULT = resultPath;
let code = 1;
try {
  code = runEgoMjs(MJS, {
    timeoutMs: 1_200_000,
    env: { CREATOR_PUBLISH_RUN: runPath, CREATOR_PUBLISH_RESULT: resultPath },
  });
} finally {
  try { fs.unlinkSync(runPath); } catch { /* ok */ }
}
if (fs.existsSync(resultPath)) console.log(fs.readFileSync(resultPath, 'utf8'));
process.exit(code);
