# xiaohongshu

```yaml
id: xiaohongshu
capabilities: [image_carousel]
via: ego
default_mode: draft
allowed_modes: [draft, submit]
```

## inputs

| field | required | notes |
|---|---|---|
| profileId | yes | ego profile |
| images | yes | comma-separated absolute image paths |
| title | yes | string |
| body / body-file | no | caption HTML/text value or file（纯文本保留段落/`<br>`） |
| topics / tags | no | comma-separated；点「话题」+ 键入词条 → 优先鼠标点击 `.tippy-content` 实时热词推荐（未匹配时敲 `Space` 兜底），生成可点击蓝色 `<a class="tiptap-topic">` |
| hotspot / activity / no-auto-hotspot / shot-dir | no | optional hotspot keyword(s), opt-out flag (`--no-auto-hotspot`), or screenshot directory |

## behavior

- Topics: click **话题** → type keyword → match & click the live `.tippy-content` trending suggestion to attach `<a class="tiptap-topic">` with platform topic ID (falls back to **Space** only if no suggestion matches). When `<6` topics and `autoHotspot` is on, may add 1–2 matching recommend topic chips.
- **原创声明** is turned ON by default after form fill.
- draft: images uploaded + title/body/topics filled + originality on + screenshots saved (`xhs_before_draft.png` / `xhs_after_draft.png`) + **暂存离开**

## run

1. `node runtime/write_job.mjs --platform xiaohongshu --profile-id <id> --images C:/a.jpg,C:/b.jpg --title "..." --body "..." --topics a,b`
2. Ego: `runtime/social/xhs_draft.mjs`
