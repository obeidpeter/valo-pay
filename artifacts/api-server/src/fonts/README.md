# Typeface embedded in the PDF exports

`valo-pack-sans.ts` carries Valo Pack Sans, regular and bold: a Latin subset of Liberation Sans 2.1.5 (Red Hat, SIL Open Font License 1.1; `LICENSE.md`), renamed because the licence reserves the name "Liberation" for the unmodified fonts. Liberation Sans has the same letter widths as Helvetica, so the packs lay out exactly as they did with the PDF standard font; unlike it, it carries the letters Nigerian names are written with (ẹ, ọ, ṣ, tone-marked vowels) and the naira sign, which the standard fonts cannot encode at all.

The two weights are stored as base64 in a TypeScript module rather than as `.ttf` files, so they travel with the source through any text-only path (the GitHub snapshot tool accepts source files only) and the API needs no file access at run time; the bundle decodes them once, on the first export. The subset keeps Basic Latin, Latin-1, Latin Extended-A and B, the combining marks (U+0300–036F), Latin Extended Additional (U+1E00–1EFF, the dot-below letters), general punctuation, currency symbols, and the arrows, comparison and box symbols the packs print, with the kerning and mark-positioning tables: 1,091 glyphs, about 130 kB a weight. pdfkit embeds only the glyphs a document uses.

Regenerate from the installed Liberation fonts with `scripts/subset-pack-fonts.sh` (needs `pip install fonttools`).
