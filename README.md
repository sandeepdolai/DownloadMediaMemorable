# MemorableDay.in

Astro rebuild of the MemorableDay.in landing page.

## Requirements

- Node.js 24 or newer
- npm

## Local development

```sh
npm install
npm run dev
```

The `predev` script extracts the three original transparent PNG assets from
`memorableday_assets.zip` into `public/assets/` before Astro starts.

## Production build

```sh
npm run build
npm run preview
```

The `prebuild` script prepares the original logo, play orb, and globe orb.
Astro writes the static site to `dist/`.

## Deployment

Every push to `main` builds the Astro site and deploys `dist/` to GitHub Pages.
The project is configured for the repository URL:

`https://sandeepdolai.github.io/Downloadmedia/`
