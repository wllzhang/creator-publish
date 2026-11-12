# creator-publish

[English](README.md)
[![skills.sh 安装次数](https://skills.sh/b/wllzhang/creator-publish)](https://skills.sh/wllzhang/creator-publish)

面向 AI Agent 的通用多平台创作者发布技能。

传入 `profileId` + `platform` + 明确字段值或绝对文件路径即可。不管理内容目录、不维护账号表、不负责内容创作。

## 安装

```bash
npx skills add wllzhang/creator-publish
```

或使用 Skills Manager：

```bash
skills-manager-cli skills install wllzhang/creator-publish
skills-manager-cli skills deploy creator-publish --agent cursor
```

## 统一入口

```bash
node runtime/run.mjs --platform <id> ...
```

| 平台 | 方式 | 默认模式 | 调用示例 |
|---|---|---|---|
| `douyin` | Ego 浏览器 | draft（草稿） | `node runtime/run.mjs --platform douyin --profile-id "Profile 2" --video "C:\abs\video.mp4" --title "标题" --topics "a,b"` |
| `bilibili` | Ego 浏览器 | draft（草稿） | `node runtime/run.mjs --platform bilibili --profile-id "Profile 2" --video "C:\abs\video.mp4" --title "标题" --topics "a,b"` |
| `weixin_channels` | Ego 浏览器 | draft（草稿） | `node runtime/run.mjs --platform weixin_channels --profile-id "Profile 2" --video "C:\abs\视频.mp4" --title "短标题" --body "描述"` |
| `xiaohongshu` | Ego 浏览器 | draft（草稿） | `node runtime/run.mjs --platform xiaohongshu --profile-id "Profile 2" --images "C:\a.jpg,C:\b.jpg" --title "标题" --body "文案"` |
| `fanqie_short` | Ego 浏览器 | submit（省略 `--submit` 则为草稿） | `node runtime/run.mjs --platform fanqie_short --profile-id "Profile 2" --title "书名" --body-file "C:\abs\body.md" --cover "C:\abs\cover.png"` |
| `ximalaya_audio` | Ego 浏览器 | submit（省略 `--submit` 则为草稿） | `node runtime/run.mjs --platform ximalaya_audio --profile-id "Profile 2" --album-id "123" --title "标题" --mp3 "C:\abs\a.mp3" --intro-file "C:\abs\intro.txt"` |
| `kdp_ebook` | Ego 浏览器 | submit（省略 `--submit` 则为草稿） | `node runtime/run.mjs --platform kdp_ebook --profile-id "Profile 2" --epub "C:\abs\book.epub" --cover "C:\abs\cover.jpg" --title "Title"` |
| `wechat_mp` | 公众号官方 API（Node） | draft（草稿） | `node runtime/run.mjs --platform wechat_mp --api-env "C:\abs\wechat_mp.env" --title "标题" --html-file "C:\abs\article.html" --cover "C:\abs\cover.jpg"` |

字段说明见 [`platforms/`](platforms/)，运行示例见 [`runtime/README.md`](runtime/README.md)。

## 环境要求

- Node.js 18+（微信公众号走白名单主机时，远端也需要 `node`）
- [Ego Lite](https://ego) / `ego-browser`（浏览器类平台）
- 微信公众号：`api-env` 中配置 `WECHAT_MP_APPID` / `WECHAT_MP_APPSECRET`；IP 白名单场景可选用 SSH egress（`WECHAT_MP_EGRESS` / `WECHAT_MP_EGRESS_SSH`）

## 硬性规则

- 未经本轮明确授权、且平台未允许 `submit` 时，不得点击最终发布
- 浏览器 `taskSpace` 必须使用给定的 `profileId`
- UI 操作之间使用拟人随机停顿
- 媒体文件只接受绝对路径
- 不要把 token / cookie 写进 skill 树

## License

MIT

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=wllzhang/creator-publish&type=Date)](https://www.star-history.com/#wllzhang/creator-publish&Date)
