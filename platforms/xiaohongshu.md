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
| body / body-file | no | caption HTML/text value or file |
| topics / tags | no | comma-separated |

## run

1. `node runtime/write_job.mjs --platform xiaohongshu --profile-id <id> --images C:/a.jpg,C:/b.jpg --title "..." --body "..."`
2. Ego: `runtime/social/xhs_draft.mjs`
