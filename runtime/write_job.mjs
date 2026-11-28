#!/usr/bin/env node
/**
 * Write creator-publish job.json.
 * Always: --platform --profile-id
 * Never a "content directory" — only field values or absolute file paths.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, need } from './lib/cli_args.mjs';
import { tmpJoin } from './lib/ego_util.mjs';
import { parseScheduleTime } from './lib/ego_dom.mjs';

const PLATFORMS = new Set([
  'douyin', 'bilibili', 'weixin_channels', 'xiaohongshu', 'wechat_mp',
  'fanqie_short', 'ximalaya_audio', 'kdp_ebook', 'x', 'youtube',
]);
const DEFAULT_MODE = {
  douyin: 'draft', bilibili: 'draft', weixin_channels: 'draft', xiaohongshu: 'draft', wechat_mp: 'draft',
  x: 'draft', youtube: 'draft',
  fanqie_short: 'submit', ximalaya_audio: 'submit', kdp_ebook: 'submit',
};

function absOrNull(p) {
  if (!p) return null;
  return path.resolve(String(p)).replace(/\\/g, '/');
}

function splitList(s) {
  return String(s || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

function readMaybeFile(value, fileFlag) {
  if (fileFlag) return fs.readFileSync(path.resolve(fileFlag), 'utf8');
  if (value === undefined || value === null) return null;
  return String(value);
}

function parseBoolFlag(val, defaultVal = false) {
  if (val === undefined || val === null || val === '') return defaultVal;
  if (typeof val === 'boolean') return val;
  const norm = String(val).trim().toLowerCase();
  if (norm === 'true' || norm === 'yes' || norm === '1' || norm === 'on') return true;
  if (norm === 'false' || norm === 'no' || norm === '0' || norm === 'off') return false;
  console.error(`invalid boolean flag value: ${val}`);
  process.exit(2);
}

const args = parseArgs();
const platform = need(args, 'platform');
if (!PLATFORMS.has(platform)) {
  console.error('unknown --platform', platform);
  process.exit(2);
}
// Ego platforms need profileId; wechat_mp is official API only.
const profileId = platform === 'wechat_mp'
  ? (args['profile-id'] || null)
  : need(args, 'profile-id');
const topics = splitList(args.topics || args.tags);
const images = splitList(args.images).map((p) => absOrNull(p));
const keywords = splitList(args.keywords);
const mode = args.mode || DEFAULT_MODE[platform];
if ((platform === 'x' || platform === 'youtube') && (args.submit || mode !== 'draft')) {
  console.error(`Draft-only safety gate blocks submit on '${platform}'`);
  process.exit(2);
}
const out = path.resolve(args.out || tmpJoin('creator-publish-job.json'));
const autoHotspot = !(
  args['no-auto-hotspot'] === true ||
  args['no-auto-hotspot'] === 'true' ||
  args['auto-hotspot'] === 'false'
);
const aiGenerated = parseBoolFlag(args['ai-generated'], false);
const rawSchedule = args['schedule-time'] || args.schedule || null;
const scheduleInfo = rawSchedule ? parseScheduleTime(rawSchedule) : null;
const scheduleTime = scheduleInfo ? scheduleInfo.dateTimeStr : null;

const job = {
  platform,
  mode,
  profileId,
  scheduleTime,
  keepOpen: args['keep-open'] === true || args['keep-open'] === 'true',
  aiGenerated,
  // video platforms
  video: absOrNull(args.video),
  title: args.title || null,
  shortTitle: args['short-title'] || null,
  topics,
  cover: absOrNull(args.cover),
  body: readMaybeFile(args.body, args['body-file']),
  shotDir: absOrNull(args['shot-dir']),
  hotspot: args.hotspot || null,
  activity: args.activity || null,
  autoHotspot,
  // xiaohongshu
  images: images.length ? images : null,
  // wechat
  html: readMaybeFile(args.html, args['html-file']),
  htmlFile: absOrNull(args['html-file']),
  bodyImages: splitList(args['body-images']).map((p) => absOrNull(p)),
  apiEnv: absOrNull(args['api-env']),
  digest: args.digest || null,
  author: args.author || null,
  // resolved at run time by wechat_mp_draft.mjs from --egress / env / api-env
  egress: args.egress || process.env.WECHAT_MP_EGRESS || null,
  // fanqie / bilibili
  bodyFile: absOrNull(args['body-file']),
  category: args.category || args.partition || null,
  partition: args.partition || args.category || null,
  // ximalaya
  mp3: absOrNull(args.mp3),
  lrc: absOrNull(args.lrc),
  intro: readMaybeFile(args.intro, args['intro-file']),
  albumId: args['album-id'] || null,
  // kdp
  epub: absOrNull(args.epub),
  subtitle: args.subtitle || null,
  authorFirst: args['author-first'] || null,
  authorLast: args['author-last'] || null,
  descriptionHtml: readMaybeFile(args['description-html'], args['description-file']),
  keywords,
  listPrice: args['list-price'] ? Number(args['list-price']) : null,
};

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(job, null, 2), 'utf8');
console.log(out);
console.error('CREATOR_PUBLISH_JOB=' + out);
