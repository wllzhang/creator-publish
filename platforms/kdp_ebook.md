# kdp_ebook

```yaml
id: kdp_ebook
capabilities: [ebook_kdp]
via: ego
default_mode: submit
allowed_modes: [draft, submit]
```

## inputs

| field | required | notes |
|---|---|---|
| profileId | yes | ego profile |
| epub | yes | absolute path |
| cover | yes | absolute path |
| title | yes | string |
| subtitle | no | string |
| author-first / author-last | no | strings |
| description-html / description-file | no | HTML value or file |
| keywords | no | comma-separated |
| list-price | no | number |
| ai-generated | no | `yes` \| `no` (default `no`; KDP Generative AI disclosure) |
| result-file | no | absolute path to output result JSON |

## run

```text
node runtime/run.mjs --platform kdp_ebook \
  --profile-id <id> \
  --epub C:/abs/book.epub \
  --cover C:/abs/cover.jpg \
  --title "..." \
  --author-first A --author-last B
```

## helper tools (`runtime/novel/tools/`)

- `python runtime/novel/tools/make_kdp_cover.py --out C:/abs/cover.jpg --title "..." --subtitle "..." --author "..."`
- `python runtime/novel/tools/build_epub.py --out C:/abs/book.epub --title "..." --author "..." --manuscript-md C:/abs/manuscript.md --cover C:/abs/cover.jpg`
- `python runtime/novel/tools/build_pitch_pdf.py --input C:/abs/pitch.md --out C:/abs/pitch_deck.pdf`
