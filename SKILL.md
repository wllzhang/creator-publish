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

Fields per platform: [`platforms/`](platforms/). Summary:

| platform | fields |
|---|---|
| douyin / bilibili / weixin_channels | `video`, `title`, optional `topics`, `cover`, `body` |
| xiaohongshu | `images` (file list), `title`, optional `body`/`body-file`, `topics` |
| wechat_mp | `api-env`, `title`, `html`/`html-file`, `cover`, optional `body-images`; egress 从 `--egress` / env / api-env（含已有 `WECHAT_MP_EGRESS_IP`）解析，不走 VPN |
| fanqie_short | `title`, `body`/`body-file`, `cover`, optional `category` |
| ximalaya_audio | `album-id`, `title`, `mp3`, `intro`/`intro-file`, optional `cover`,`lrc` |
| kdp_ebook | `epub`, `cover`, `title`, optional metadata flags |

## Layout

| Path | Role |
|---|---|
| [`platforms/`](platforms/) | Capability + required inputs per platform |
| [`runtime/run.mjs`](runtime/run.mjs) | **Unified entry** for all platforms |
| [`runtime/`](runtime/) | Ego / WeChat adapters (also callable directly) |

## Agent flow

1. Collect `platform` + explicit fields/files (+ `profileId` when Ego)  
2. `node runtime/run.mjs --platform …`  
3. Note result (platform / mode / status / paths)  

## Hard rules

- Social: do not click final publish unless this-turn explicit authorization and platform allows `submit`
- Every Ego `taskSpace` must use the given `profileId`
- Random human pacing between UI actions
- Media uploads/screenshots: absolute paths only
- No tokens/cookies in the skill tree
