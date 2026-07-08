# OG_Image/ — source for the Open Graph share image (KEEP)

**Do not delete this directory as "unused." It is intentional.**

`OG_Image_Photoshop.psd` is the **editable Photoshop master** for the social
share/preview image. It exports to:

- `public/og-image.png` — the file actually served in `<meta og:image>` tags.

### Why it looks unused (and isn't)
The server never references the `.psd` — it only serves the exported PNG in
`public/`. The source is kept here on purpose so the share image can be edited
and re-exported later. A `.png` alone is not re-editable; the layered `.psd` is.
