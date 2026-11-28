---
name: creator-publish
description: >-
  Generic multi-platform creator publishing. Pass profileId + platform + explicit
  field values or absolute file paths (no content directories). Match capabilities,
  run draft or submit adapters. No account roster; no content authoring.
---

# creator-publish

**No content directories.** Every input is a parameter value or an absolute file path.

## Call shape

```text
node runtime/run.mjs --platform <id> [profileId + platform fields] [mode?]
```

| Common | Meaning |
|---|---|
| `profileId` | Ego profile id (required for browser platforms; unused for `wechat_mp`) |
| `platform` | see `platforms/` |
| `mode` | `draft` = stop before final publish; `submit` = confirm. Omit → platform `default_mode` |
| `hotspot` / `activity` / `no-auto-hotspot` | Social platforms auto-associate platform hotspot/trending suggestions/activities by default from `topics` + `title`; pass `--hotspot`/`--activity` to override or `--no-auto-hotspot` to disable |
| `ai-generated` | Social platforms (`douyin` / `xiaohongshu` / `weixin_channels` / `bilibili`): pass `--ai-generated` to auto-select the platform's "AI-generated / AI-synthesized content" disclosure (default `false`); `kdp_ebook` uses `yes` \| `no` |
| `shot-dir` | Optional directory for before/after draft proof screenshots |
| `keep-open` | Optional flag (`--keep-open`) to retain the browser tab after finishing instead of closing the Ego taskSpace |

Fields per platform: [`platforms/`](platforms/). Summary:

| platform | fields |
|---|---|
| douyin | `video`, `title`, optional `topics`, `cover`, `body`, `ai-generated` |
| bilibili | `video`, `title`, optional `topics`, `cover`, `body`, `partition`, `ai-generated` |
| weixin_channels | `video`, `title`, optional `topics`, `cover`, `body`, `ai-generated` |
| xiaohongshu | `images` (file list) OR `video` (+ optional `cover`), `title`, optional `body`/`body-file`, `topics`, `ai-generated` |
| x | `body`/`body-file` or `title`, optional `images` (≤4) OR `video`, `topics` (`draft` only) |
| youtube | `video`, `title`, optional `body`/`body-file`, `topics`, `cover`, `ai-generated` (`draft` only) |
| wechat_mp | `api-env`, `title`, `html`/`html-file`, `cover`, optional `body-images`, `profile-id`（用于 API 入库后经 Ego 自动声明原创并复核开启留言）, `no-original`, `no-comment`, `only-fans-comment`; 默认 `need_open_comment=1` 开启留言; egress 从 `--egress` / env / api-env（含已有 `WECHAT_MP_EGRESS_IP`）解析，不走 VPN |
| fanqie_short | `title`, `body`/`body-file`, optional `cover`, `category`, `trial` (default `75`) |
| ximalaya_audio | `album-id`, `title`, `mp3`, `intro`/`intro-file`, optional `cover`,`lrc`,`result-file` |
| kdp_ebook | `epub`, `cover`, `title`, optional metadata flags, `ai-generated`, `result-file` |
| gmail | `to`, `subject`, `body`/`body-file`, optional `attachments`, `account-index`, `result-file` (default `draft`) |

## Layout

| Path | Role |
|---|---|
| [`platforms/`](platforms/) | Capability + required inputs per platform |
| [`runtime/run.mjs`](runtime/run.mjs) | **Unified entry** for all platforms |
| [`runtime/`](runtime/) | Ego / WeChat adapters (invoked by `run.mjs`) |

## Agent flow

1. Collect `platform` + explicit fields/files (+ `profileId` when Ego)  
2. `node runtime/run.mjs --platform …`  
3. Note result (platform / mode / status / paths)  

## Hard rules

- Social: do not click final publish unless this-turn explicit authorization and platform allows `submit`
- Every Ego `taskSpace` must use the given `profileId`
- Random human pacing between UI actions
- Media uploads/screenshots: absolute paths only
- WeChat MP: pass `--ssh-key` (or `WECHAT_MP_SSH_KEY`) when calling Tencent/whitelist SSH egress from Linux/Muse (auto-uses `~/.ssh/id_ed25519_muse` if present)
- Remote Ego dispatch (from Muse/Linux without Playwright): `node runtime/remote_ego_dispatch.mjs --platform <id> --profile-id "<id>" ...` (dispatches to Windows desktop Ego bridge or enqueues offline under `/home/hatch/work/publish_queue/`)
- No tokens/cookies in the skill tree
