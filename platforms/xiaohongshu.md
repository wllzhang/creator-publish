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
| topics / tags | no | comma-separated；点「话题」+ 键入词条 + 空格 `Space`，生成可点击蓝色 `<a class="tiptap-topic">`（勿只写纯文本 `#标签`） |

## behavior

- Topics: click **话题** → type keyword → wait tippy highlight → press **Space** to create `<a class="tiptap-topic">` (plain `#tag` text is not a real topic; do not Space before suggestions settle or recommend chips may steal the confirm).
- **原创声明** is turned ON by default after form fill.
- draft: images uploaded + title/body/topics filled + originality on + **暂存离开**

## run

1. `node runtime/write_job.mjs --platform xiaohongshu --profile-id <id> --images C:/a.jpg,C:/b.jpg --title "..." --body "..." --topics a,b`
2. Ego: `runtime/social/xhs_draft.mjs`
