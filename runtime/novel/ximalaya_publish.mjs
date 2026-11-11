#!/usr/bin/env node
/** Ximalaya: --profile-id --album-id --title --mp3 --intro|--intro-file [--cover] [--lrc] [--submit] */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, need } from '../lib/cli_args.mjs';
import { runEgoMjs, tmpJoin } from '../lib/ego_util.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MJS = path.join(HERE, 'ximalaya_ego.mjs');
const TITLE_MAX = 40;

function readIntro(args) {
  if (args['intro-file']) return fs.readFileSync(path.resolve(args['intro-file']), 'utf8').trim();
  if (args.intro) return String(args.intro).trim();
  throw new Error('need --intro or --intro-file');
}

const args = parseArgs();
const profileId = need(args, 'profile-id');
const albumId = need(args, 'album-id');
const title = String(need(args, 'title')).trim();
const mp3 = path.resolve(need(args, 'mp3'));
if (!fs.existsSync(mp3)) {
  console.error('mp3 not found:', mp3);
  process.exit(2);
}
if (title.length > TITLE_MAX) {
  console.error(`title too long (${title.length} > ${TITLE_MAX})`);
  process.exit(2);
}
let intro;
try {
  intro = readIntro(args);
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
const cover = args.cover ? path.resolve(args.cover) : null;
const lrc = args.lrc ? path.resolve(args.lrc) : null;
if (cover && !fs.existsSync(cover)) {
  console.error('cover not found:', cover);
  process.exit(2);
}
if (lrc && !fs.existsSync(lrc)) {
  console.error('lrc not found:', lrc);
  process.exit(2);
}

const plan = {
  title,
  intro,
  tags: args['with-tags'] && args.tags
    ? String(args.tags).split(',').map((t) => t.trim()).filter(Boolean)
    : [],
  mp3: mp3.replace(/\\/g, '/'),
  lrc: lrc ? lrc.replace(/\\/g, '/') : '',
  cover: cover ? cover.replace(/\\/g, '/') : '',
  album_id: albumId,
  submit: !!args.submit,
  ai: !args['no-ai'],
  profileId,
  profile_id: profileId,
  space_name: 'ximalaya-' + new Date().toISOString().replace(/[:.]/g, '-'),
};
console.log(JSON.stringify({ ...plan, intro: plan.intro.slice(0, 40) + '…' }, null, 2));
if (args.check) process.exit(0);

const runPath = tmpJoin('creator-publish-ximalaya-run.json');
const resultPath = tmpJoin('creator-publish-ximalaya-result.json');
fs.writeFileSync(runPath, JSON.stringify(plan, null, 2), 'utf8');
try { fs.unlinkSync(resultPath); } catch { /* ok */ }
process.env.CREATOR_PUBLISH_RUN = runPath;
process.env.CREATOR_PUBLISH_RESULT = resultPath;
const code = runEgoMjs(MJS, { timeoutMs: 3_600_000 });
if (fs.existsSync(resultPath)) console.log(fs.readFileSync(resultPath, 'utf8'));
process.exit(code);
