# MemorableDay.in

Astro rebuild of the MemorableDay.in media-downloader landing page, using the original visual assets supplied in `memorableday_assets.zip`.

## Requirements

- Node.js 24 or newer
- npm

## Local development

```sh
npm install
npm run dev
```

The `predev` script extracts the original transparent PNG assets from the ZIP into `public/assets/`.

## Production build

```sh
npm run build
npm run preview
```

The page is built as a static Astro site in `dist/`. The feature banner is composed from the original liquid sculpture and 3D social-platform PNG cutouts; the diagonal feature ribbons are styled in CSS.

## Deployment

The `Deploy MemorableDay.in (Astro)` GitHub Actions workflow builds and deploys `dist/` to GitHub Pages whenever `main` changes.

Live site: https://sandeepdolai.github.io/Downloadmedia/
