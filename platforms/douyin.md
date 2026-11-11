# douyin

```yaml
id: douyin
capabilities: [video_mp4]
via: ego
default_mode: draft
allowed_modes: [draft, submit]
```

## inputs（video_mp4）

| field | required | notes |
|---|---|---|
| profileId | yes | ego profile |
| video | yes | absolute path to mp4 |
| title | yes | title |
| topics | no | topic/hashtag list |

## success_when

- draft: uploaded + title/topics filled, stop before publish (`DOUYIN_STAGED_STOP_BEFORE_PUBLISH`)

## run

1. `node runtime/write_job.mjs --platform douyin --profile-id <id> --video ... --title ... --topics a,b`
2. Ego: `runtime/social/douyin_draft.mjs`

