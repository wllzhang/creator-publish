#!/usr/bin/env node
/**
 * WeChat MP draft/add (Node only). Run on whitelist egress or local allowlisted IP.
 * Self-contained (no relative imports) so it can be scp'd alone to the egress host.
 */
import fs from 'node:fs';
import path from 'node:path';

const API = 'https://api.weixin.qq.com';

function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    if (eq !== -1) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function need(args, key) {
  if (args[key] === undefined || args[key] === '') {
    console.error(`missing --${key}`);
    process.exit(2);
  }
  return args[key];
}

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

async function httpJson(url, { method = 'GET', body, headers } = {}) {
  const res = await fetch(url, { method, body, headers });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`non-json HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
  return json;
}

function multipart(files) {
  const boundary = '----CreatorPublishForm' + Date.now().toString(16);
  const chunks = [];
  for (const [name, { filename, buffer, contentType }] of Object.entries(files)) {
    chunks.push(Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`,
    ));
    chunks.push(buffer);
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function imageContentType(p) {
  const ext = path.extname(p).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

async function getToken(appid, secret) {
  const q = new URLSearchParams({
    grant_type: 'client_credential',
    appid,
    secret,
  });
  const j = await httpJson(`${API}/cgi-bin/token?${q}`);
  if (!j.access_token) {
    throw new Error(`token failed: ${JSON.stringify({ errcode: j.errcode, errmsg: j.errmsg })}`);
  }
  return j.access_token;
}

async function uploadContentImage(token, filePath) {
  const buf = fs.readFileSync(filePath);
  const { body, contentType } = multipart({
    media: { filename: path.basename(filePath), buffer: buf, contentType: imageContentType(filePath) },
  });
  const url = `${API}/cgi-bin/media/uploadimg?access_token=${encodeURIComponent(token)}`;
  const j = await httpJson(url, { method: 'POST', body, headers: { 'Content-Type': contentType } });
  if (!j.url) throw new Error(`uploadimg failed ${path.basename(filePath)}: ${JSON.stringify(j)}`);
  return j.url;
}

async function uploadThumb(token, filePath) {
  const buf = fs.readFileSync(filePath);
  const { body, contentType } = multipart({
    media: { filename: path.basename(filePath), buffer: buf, contentType: imageContentType(filePath) },
  });
  const url =
    `${API}/cgi-bin/material/add_material?access_token=${encodeURIComponent(token)}&type=image`;
  const j = await httpJson(url, { method: 'POST', body, headers: { 'Content-Type': contentType } });
  if (!j.media_id) throw new Error(`add_material failed: ${JSON.stringify(j)}`);
  return j.media_id;
}

function extractBodyHtml(html) {
  const m1 = html.match(/(<section class="container"[^>]*>[\s\S]*<\/section>)/i);
  if (m1) return m1[1];
  const m2 = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (m2) return m2[1].trim();
  return html;
}

function replaceLocalImgs(html, mapping) {
  let out = html;
  for (const [localName, cdn] of Object.entries(mapping)) {
    const re = new RegExp(
      `(src|data-local-path)="[^"]*${localName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`,
      'gi',
    );
    out = out.replace(re, `src="${cdn}"`);
  }
  out = out.replace(/\sdata-local-path="[^"]*"/gi, '');
  return out;
}

const args = parseArgs();
const apiEnv = path.resolve(need(args, 'api-env'));
const title = need(args, 'title');
const htmlFile = path.resolve(need(args, 'html-file'));
const cover = path.resolve(need(args, 'cover'));
const out = path.resolve(args.out || 'api_draft_result.json');
const digest = args.digest || '';

if (!fs.existsSync(apiEnv)) {
  console.error('api-env not found:', apiEnv);
  process.exit(2);
}
if (!fs.existsSync(htmlFile)) {
  console.error('html-file not found:', htmlFile);
  process.exit(2);
}
if (!fs.existsSync(cover)) {
  console.error('cover not found:', cover);
  process.exit(2);
}

const env = loadEnvFile(apiEnv);
const appid = env.WECHAT_MP_APPID || env.APPID;
const secret = env.WECHAT_MP_APPSECRET || env.APPSECRET || env.SECRET;
if (!appid || !secret) {
  console.error('env must define WECHAT_MP_APPID and WECHAT_MP_APPSECRET');
  process.exit(2);
}
const author = args.author || env.WECHAT_MP_AUTHOR || env.AUTHOR || '';

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

let html = extractBodyHtml(fs.readFileSync(htmlFile, 'utf8'));
console.log('[*] token…');
const token = await getToken(appid, secret);
console.log('[+] token ok');

const mapping = {};
for (const img of bodyImages) {
  console.log('[*] uploadimg', path.basename(img));
  const url = await uploadContentImage(token, img);
  mapping[path.basename(img)] = url;
  console.log('   ', url.slice(0, 80) + '…');
}
html = replaceLocalImgs(html, mapping);
if (bodyImages.length && !/mmbiz\.qpic\.cn|mmbiz\.qlogo\.cn/.test(html)) {
  console.warn('[!] warning: no mmbiz CDN urls detected in content after replace');
}

console.log('[*] add_material cover');
const thumbMediaId = await uploadThumb(token, cover);

const article = {
  title: String(title).slice(0, 64),
  author: String(author).slice(0, 16),
  digest: String(digest).slice(0, 120),
  content: html,
  content_source_url: '',
  thumb_media_id: thumbMediaId,
  need_open_comment: 0,
  only_fans_can_comment: 0,
};

console.log('[*] draft/add');
const addUrl = `${API}/cgi-bin/draft/add?access_token=${encodeURIComponent(token)}`;
const j = await httpJson(addUrl, {
  method: 'POST',
  body: Buffer.from(JSON.stringify({ articles: [article] }), 'utf8'),
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
});
if (!j.media_id) throw new Error(`draft/add failed: ${JSON.stringify(j)}`);

const result = {
  status: 'draft_ok',
  success: true,
  media_id: j.media_id,
  thumb_media_id: thumbMediaId,
  title,
  author,
  body_image_cdn: mapping,
  egress: 'api_draft.mjs',
};
fs.writeFileSync(out, JSON.stringify(result, null, 2), 'utf8');
console.log(JSON.stringify(result, null, 2));
console.log('WECHAT_MP_DRAFT_OK', j.media_id);
