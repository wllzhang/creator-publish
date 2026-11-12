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

| Platform | Via | Default mode | Example |
|---|---|---|---|
| `douyin` | Ego browser | draft | `node runtime/run.mjs --platform douyin --profile-id "Profile 2" --video "C:\abs\video.mp4" --title "Title" --topics "a,b"` |
| `bilibili` | Ego browser | draft | `node runtime/run.mjs --platform bilibili --profile-id "Profile 2" --video "C:\abs\video.mp4" --title "Title" --topics "a,b"` |
| `weixin_channels` | Ego browser | draft | `node runtime/run.mjs --platform weixin_channels --profile-id "Profile 2" --video "C:\abs\video.mp4" --title "Short title" --body "Caption"` |
| `xiaohongshu` | Ego browser | draft | `node runtime/run.mjs --platform xiaohongshu --profile-id "Profile 2" --images "C:\a.jpg,C:\b.jpg" --title "Title" --body "Caption"` |
| `fanqie_short` | Ego browser | submit (omit `--submit` for draft) | `node runtime/run.mjs --platform fanqie_short --profile-id "Profile 2" --title "Book" --body-file "C:\abs\body.md" --cover "C:\abs\cover.png"` |
| `ximalaya_audio` | Ego browser | submit (omit `--submit` for draft) | `node runtime/run.mjs --platform ximalaya_audio --profile-id "Profile 2" --album-id "123" --title "Title" --mp3 "C:\abs\a.mp3" --intro-file "C:\abs\intro.txt"` |
| `kdp_ebook` | Ego browser | submit (omit `--submit` for draft) | `node runtime/run.mjs --platform kdp_ebook --profile-id "Profile 2" --epub "C:\abs\book.epub" --cover "C:\abs\cover.jpg" --title "Title"` |
| `wechat_mp` | Official API (Node) | draft | `node runtime/run.mjs --platform wechat_mp --api-env "C:\abs\wechat_mp.env" --title "Title" --html-file "C:\abs\article.html" --cover "C:\abs\cover.jpg"` |

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
