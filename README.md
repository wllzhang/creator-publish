# creator-publish

Generic multi-platform creator publishing skill for AI agents.

Pass `profileId` + `platform` + explicit field values or absolute file paths. No content directories, no account roster, no content authoring.

[![skills.sh](https://skills.sh/b/wllzhang/creator-publish)](https://skills.sh/wllzhang/creator-publish)

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

## 中文

面向 AI Agent 的通用多平台创作者发布技能。

传入 `profileId` + `platform` + 明确字段值或绝对文件路径即可。不管理内容目录、不维护账号表、不负责内容创作。

### 安装

```bash
npx skills add wllzhang/creator-publish
```

或使用 Skills Manager：

```bash
skills-manager-cli skills install wllzhang/creator-publish
skills-manager-cli skills deploy creator-publish --agent cursor
```

### 统一入口

```bash
node runtime/run.mjs --platform <id> ...
```

| 平台 | 方式 | 默认模式 |
|---|---|---|
| `douyin` / `bilibili` / `weixin_channels` / `xiaohongshu` | Ego 浏览器 | draft（草稿） |
| `fanqie_short` / `ximalaya_audio` / `kdp_ebook` | Ego 浏览器 | submit（省略 `--submit` 则为草稿） |
| `wechat_mp` | 公众号官方 API（Node） | draft（草稿） |

字段说明见 [`platforms/`](platforms/)，运行示例见 [`runtime/README.md`](runtime/README.md)。

### 环境要求

- Node.js 18+（微信公众号走白名单主机时，远端也需要 `node`）
- [Ego Lite](https://ego) / `ego-browser`（浏览器类平台）
- 微信公众号：`api-env` 中配置 `WECHAT_MP_APPID` / `WECHAT_MP_APPSECRET`；IP 白名单场景可选用 SSH egress（`WECHAT_MP_EGRESS` / `WECHAT_MP_EGRESS_SSH`）

### 硬性规则

- 未经本轮明确授权、且平台未允许 `submit` 时，不得点击最终发布
- 浏览器 `taskSpace` 必须使用给定的 `profileId`
- UI 操作之间使用拟人随机停顿
- 媒体文件只接受绝对路径
- 不要把 token / cookie 写进 skill 树

## License

MIT

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=wllzhang/creator-publish&type=Date)](https://www.star-history.com/#wllzhang/creator-publish&Date)
