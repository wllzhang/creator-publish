# creator-publish

[中文文档](README.zh-CN.md)
[![skills.sh installs](https://skills.sh/b/wllzhang/creator-publish)](https://skills.sh/wllzhang/creator-publish)

Generic multi-platform creator publishing skill for AI agents.

Pass `profileId` + `platform` + explicit field values or absolute file paths. No content directories, no account roster, no content authoring.

## Install

```bash
npx skills add wllzhang/creator-publish
```

Or with [Skills Manager](https://github.com/):

```bash
skills-manager-cli skills install wllzhang/creator-publish
skills-manager-cli skills deploy creator-publish --agent cursor
```

## Unified entry

```bash
node runtime/run.mjs --platform <id> ...
```

| Platform | Via | Default mode |
|---|---|---|
| `douyin` / `bilibili` / `weixin_channels` / `xiaohongshu` | Ego browser | draft |
| `fanqie_short` / `ximalaya_audio` / `kdp_ebook` | Ego browser | submit (omit `--submit` for draft) |
| `wechat_mp` | Official API (Node) | draft |

See [`platforms/`](platforms/) for required fields and [`runtime/README.md`](runtime/README.md) for examples.

## Requirements

- Node.js 18+ (WeChat remote egress also needs `node` on the whitelist host)
- [Ego Lite](https://ego) / `ego-browser` for browser platforms
- WeChat MP: `api-env` with `WECHAT_MP_APPID` / `WECHAT_MP_APPSECRET`; optional SSH egress when IP allowlist is used (`WECHAT_MP_EGRESS` / `WECHAT_MP_EGRESS_SSH`)

## Hard rules

- Do not click final publish unless explicitly authorized for this turn and the platform allows `submit`
- Browser `taskSpace` must use the given `profileId`
- Human-like random pacing between UI actions
- Absolute paths only for media
- Never commit tokens or cookies into the skill tree

## License

MIT

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=wllzhang/creator-publish&type=Date)](https://www.star-history.com/#wllzhang/creator-publish&Date)
