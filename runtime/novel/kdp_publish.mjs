#!/usr/bin/env node
/** KDP: --profile-id --epub --cover --title [metadata flags] [--submit] [--check] */
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

function hashCode(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
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
const desc = readDesc(args) || `<p>${title}</p>`;
const keywords = String(args.keywords || '')
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);

const cfg = {
  space_name: `kdp-pub-${Math.abs(hashCode(epub + title)) % 100000}`,
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
  submit: !!args.submit,
};
console.log(JSON.stringify({ ...cfg, description_html: undefined }, null, 2));
if (args.check) process.exit(0);
if (!findEgoExe()) {
  console.error('ego-browser not found');
  process.exit(3);
}
const runPath = tmpJoin('creator-publish-kdp-run.json');
fs.writeFileSync(runPath, JSON.stringify(cfg, null, 2), 'utf8');
process.env.CREATOR_PUBLISH_RUN = runPath;
process.exit(runEgoMjs(MJS, {
  timeoutMs: 1_200_000,
  env: { CREATOR_PUBLISH_RUN: runPath },
}));
