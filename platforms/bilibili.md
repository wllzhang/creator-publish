# bilibili

```yaml
id: bilibili
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
| topics | no | tags |
| cover | no | cover image |

## success_when

- draft: clicked save-draft and draft confirmed (`BILIBILI_DRAFT_SAVED` / `BILIBILI_DRAFT_DONE`)

## run

1. `node runtime/write_job.mjs --platform bilibili --profile-id <id> --video ... --title ...`
2. Ego: `runtime/social/bilibili_draft.mjs`

