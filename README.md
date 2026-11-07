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


## Downloader API (new)

The Astro site remains on GitHub Pages. The media-processing API is a separate Docker service in the server folder, deployable with the root Render Blueprint file.

### First backend scope

- Public HTTPS URLs that point directly to media files (MP4, WebM, MOV, MP3, M4A, WAV, OGG, FLAC and similar).
- Inspects file type, size and filename before offering format choices.
- Streams the original file to the browser without storing it on the server.
- Converts supported audio/video inputs to MP3 with FFmpeg.
- Rejects webpage URLs, private/login-only media, unsupported file types, private-network destinations, oversized files and unsafe redirects.

This is an initial working downloader engine, not a claim of full compatibility with every social platform. Platform-page extraction must be added only through authorized platform integrations or creator-authorized media sources. YouTube developer policies prohibit downloading/offline copies of YouTube audiovisual content without prior written approval; Meta and TikTok also restrict automated collection without permission.

### Deploy the API

1. Open Render and choose New → Blueprint.
2. Connect this repository and select the main branch. Render reads render.yaml and creates the API service.
3. The health endpoint is /health. The default service URL is configured in the Astro form. If Render assigns a different hostname, set the GitHub repository Actions variable PUBLIC_DOWNLOADER_API_URL to that URL, then rerun the Pages workflow.
4. The initial Blueprint uses Render's free plan for testing. Render documents that free web services have limitations and are not recommended for production. Upgrade the API service before public/high-volume use.

### Local API development

Run npm install and npm start inside the server folder. FFmpeg must be installed on the machine. The API listens on PORT (default 10000). Set PUBLIC_DOWNLOADER_API_URL to http://localhost:10000 when building the Astro frontend locally.

The API does not store downloaded media. It streams source media to the visitor and applies URL/DNS checks to reduce server-side request forgery risk.
