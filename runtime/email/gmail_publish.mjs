#!/usr/bin/env node
/**
 * Gmail adapter via Ego browser.
 *
 * Required: --profile-id --to --subject --body|--body-file
 * Optional: --attachments <abs[,abs2,...]> --account-index <int> --result-file <abs> --submit --check
 * Default mode: draft (does NOT click Send unless --submit is explicitly passed).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, need } from '../lib/cli_args.mjs';
import { findEgoExe, runEgoMjs, tmpJoin } from '../lib/ego_util.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MJS = path.join(HERE, 'gmail_ego.mjs');

function splitList(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function readBody(args) {
  if (args['body-file'] !== undefined) {
    if (args['body-file'] === true || String(args['body-file']).trim() === '') {
      throw new Error('invalid --body-file: expected file path');
    }
    const bf = path.resolve(String(args['body-file']));
    if (!fs.existsSync(bf) || !fs.statSync(bf).isFile()) {
      throw new Error(`body-file not found: ${bf}`);
    }
    return fs.readFileSync(bf, 'utf8').replace(/^\uFEFF/, '');
  }
  if (args.body !== undefined && args.body !== true && String(args.body) !== '') {
    return String(args.body);
  }
  throw new Error('need --body or --body-file');
}

const args = parseArgs();
const profileId = String(need(args, 'profile-id')).trim();
const toRaw = need(args, 'to');
if (toRaw === true) {
  console.error('missing --to value');
  process.exit(2);
}
const toList = splitList(toRaw);
if (toList.length === 0) {
  console.error('invalid --to: at least one recipient email is required');
  process.exit(2);
}

const subjectRaw = need(args, 'subject');
if (subjectRaw === true || String(subjectRaw).trim() === '') {
  console.error('missing --subject');
  process.exit(2);
}
const subject = String(subjectRaw).trim();

let body;
try {
  body = readBody(args);
} catch (e) {
  console.error(e.message);
  process.exit(2);
}

let attachments = [];
if (args.attachments !== undefined) {
  if (args.attachments === true) {
    console.error('invalid --attachments: expected file path(s)');
    process.exit(2);
  }
  const rawAtts = splitList(args.attachments);
  for (const rawPath of rawAtts) {
    const absAtt = path.resolve(rawPath);
    if (!fs.existsSync(absAtt) || !fs.statSync(absAtt).isFile()) {
      console.error('attachment not found:', absAtt);
      process.exit(2);
    }
    attachments.push(absAtt.replace(/\\/g, '/'));
  }
}

const accountIndex = args['account-index'] !== undefined ? Number(args['account-index']) : 0;
if (!Number.isInteger(accountIndex) || accountIndex < 0) {
  console.error('invalid --account-index (expected non-negative integer):', args['account-index']);
  process.exit(2);
}

if (args.mode !== undefined && args.mode !== 'draft' && args.mode !== 'submit') {
  console.error('invalid --mode (expected draft|submit):', args.mode);
  process.exit(2);
}
const submit = args.mode === 'draft'
  ? false
  : Boolean(args.submit === true || args.submit === 'true' || args.mode === 'submit');

const resultPath = args['result-file']
  ? path.resolve(String(args['result-file']))
  : tmpJoin('creator-publish-gmail-result.json');

const cfg = {
  space_name: `gmail-${process.pid}-${Date.now()}`,
  profileId,
  profile_id: profileId,
  account_index: accountIndex,
  to: toList,
  subject,
  body,
  attachments,
  mode: submit ? 'submit' : 'draft',
  submit,
  result_file: resultPath,
};

console.log(
  JSON.stringify(
    {
      ...cfg,
      body: cfg.body.length > 80 ? cfg.body.slice(0, 80) + '…' : cfg.body,
    },
    null,
    2,
  ),
);
if (args.check) process.exit(0);

if (!findEgoExe()) {
  console.error('ego-browser not found; start Ego Lite first');
  process.exit(3);
}

const runPath = tmpJoin(`creator-publish-gmail-run-${process.pid}-${Date.now()}.json`);
fs.mkdirSync(path.dirname(resultPath), { recursive: true });
fs.writeFileSync(runPath, JSON.stringify(cfg, null, 2), 'utf8');
try { fs.unlinkSync(resultPath); } catch { /* ok */ }
process.env.CREATOR_PUBLISH_RUN = runPath;
process.env.CREATOR_PUBLISH_RESULT = resultPath;

let code = 1;
try {
  code = runEgoMjs(MJS, {
    timeoutMs: 600_000,
    env: { CREATOR_PUBLISH_RUN: runPath, CREATOR_PUBLISH_RESULT: resultPath },
  });
} finally {
  try { fs.unlinkSync(runPath); } catch { /* ok */ }
}
if (fs.existsSync(resultPath)) console.log(fs.readFileSync(resultPath, 'utf8'));
process.exit(code);
