# ximalaya_audio

```yaml
id: ximalaya_audio
capabilities: [audiobook_album]
via: ego
default_mode: submit
allowed_modes: [draft, submit]
```

## inputs

| field | required | notes |
|---|---|---|
| profileId | yes | ego profile |
| albumId | yes | album id |
| title | yes | string |
| mp3 | yes | absolute path |
| intro / intro-file | yes | string or file |
| cover | no | absolute path |
| lrc | no | absolute path |

## run

```text
node runtime/novel/ximalaya_publish.mjs \
  --profile-id <id> \
  --album-id 123 \
  --title "..." \
  --mp3 C:/abs/a.mp3 \
  --intro-file C:/abs/intro.txt \
  --cover C:/abs/cover.png
```
