---
name: generate-image
description: Generate an image with the host Imagen model into the workspace. Use when asked for photos, illustrations, icons, heroes, or any new image file.
---

# Generate images (host Imagen)

The operator configured one image model on the Settings page. Every Pi agent can use it. Check first:

```bash
node "$CLOUD_PI_IMAGEN" status
```

If `configured` is false, stop and tell the user to add an Imagen model on Settings.

## Generate

```bash
node "$CLOUD_PI_IMAGEN" generate --prompt "description of the image" --out assets/hero.png
```

- `--out` is a path inside the workspace. Prefer `assets/`.
- `--aspect 1:1` / `16:9` / `9:16` / `4:3` for Google Gemini / Imagen.
- `--size 1024x1024` for OpenAI-compatible endpoints.

The command prints JSON with `path`. Use that file from HTML/CSS. Do not curl `/api/*`. Do not write the API key into the workspace.
