# fanqie_short

```yaml
id: fanqie_short
capabilities: [novel_short]
via: ego
default_mode: submit
allowed_modes: [draft, submit]
```

## inputs

| field | required | notes |
|---|---|---|
| profileId | yes | ego profile |
| title | yes | string |
| body / body-file | yes | text value, or absolute path to text/markdown file |
| cover | yes | absolute path to cover image |
| category | no | platform category string |

## run

```text
node runtime/novel/fanqie_publish.mjs \
  --profile-id <id> \
  --title "..." \
  --body-file C:/abs/body.md \
  --cover C:/abs/cover.png \
  --category 都市日常
```

Add `--submit` to confirm publish; omit to stop before confirm (`draft`).
