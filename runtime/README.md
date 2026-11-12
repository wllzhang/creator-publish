# runtime/（纯 Node.js）

输入只有：**参数值**或**文件绝对路径**。没有 `bookDir` / `cardsDir`。

## 统一入口（推荐）

```powershell
node runtime/run.mjs --platform <id> ...
```

| platform | 说明 |
|---|---|
| `douyin` | write_job + Ego |
| `bilibili` | write_job + Ego |
| `weixin_channels` | write_job + Ego |
| `xiaohongshu` | write_job + Ego |
| `fanqie_short` | novel 适配器 |
| `ximalaya_audio` | novel 适配器 |
| `kdp_ebook` | novel 适配器 |
| `wechat_mp` | 官方 API（SSH 出口 / local） |

### 社媒示例

```powershell
node runtime/run.mjs --platform douyin --profile-id "Profile 2" --video "C:\abs\video.mp4" --title "Title" --topics "a,b"
node runtime/run.mjs --platform xiaohongshu --profile-id "Profile 2" --images "C:\a.jpg,C:\b.jpg" --title "Title" --body "caption"
node runtime/run.mjs --platform weixin_channels --profile-id "Profile 2" --video "C:\abs\视频.mp4" --title "短标题" --body "描述"
```

视频号须用**可用成片**（过短残片可能无法保存草稿）。

### 小说示例

```powershell
node runtime/run.mjs --platform fanqie_short --profile-id "Profile 2" --title "书名" --body-file "C:\abs\body.md" --cover "C:\abs\cover.png"
node runtime/run.mjs --platform ximalaya_audio --profile-id "Profile 2" --album-id "123" --title "标题" --mp3 "C:\abs\a.mp3" --intro-file "C:\abs\intro.txt"
node runtime/run.mjs --platform kdp_ebook --profile-id "Profile 2" --epub "C:\abs\book.epub" --cover "C:\abs\cover.jpg" --title "Title"
```

真发加 `--submit`。

### 微信公众号

```powershell
node runtime/run.mjs --platform wechat_mp `
  --api-env "C:\abs\wechat_mp.env" `
  --title "标题" `
  --html-file "C:\abs\article.html" `
  --cover "C:\abs\cover.jpg" `
  --body-images "C:\abs\1.jpg,C:\abs\2.jpg"
```

**不走本地 VPN。** 出口解析：`--egress` → env `WECHAT_MP_EGRESS` → api-env `WECHAT_MP_EGRESS` / `EGRESS_SSH` → 有 `WECHAT_MP_EGRESS_IP` 则 SSH（须同时配置 SSH 主机）→ 否则 `local`。

## 兼容入口

- `runtime/run_social.mjs` → 转发到 `run.mjs`（仅社媒）
- `runtime/novel/*_publish.mjs`、`runtime/wechat/wechat_mp_draft.mjs` 仍可直调
