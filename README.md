# MemorableDay.in

Astro website for MemorableDay.in, preserving the existing landing-page design and assets.

## Website

- Framework: Astro
- Hosting: Vercel
- Build: npm install && npm run build
- Local development: npm run dev

The downloader form keeps the existing UI and connects to the separate API at:

https://memorableday-downloader-api.onrender.com

You can override the API URL at build time with the PUBLIC_DOWNLOADER_API_URL environment variable.

## Multi-site downloader API

The separate Python service lives in the server/ directory and uses:

- FastAPI for the HTTP API.
- yt-dlp as the extraction engine for websites that its current extractors support.
- FFmpeg for merging separate audio/video streams and converting audio to MP3.
- Deno plus yt-dlp-ejs for the current YouTube JavaScript challenge integration.
- Temporary local files with automatic cleanup after the browser receives the download.

### API endpoints

- GET /health — service health and extraction-engine version.
- POST /v1/inspect — accepts JSON {"url":"https://..."}, returns media title and available formats.
- POST /v1/download — accepts form fields url and format, then streams the resulting file to the browser.

### Format IDs

- best — best available video and audio combination.
- p1080, p720, etc. — video at or below the selected resolution when available.
- audio — original audio.
- mp3 — audio converted to MP3 at 192 kbps.

The API only accepts public HTTP/HTTPS URLs, rejects local/private IP destinations at the submitted URL, disables playlist downloads, does not load browser cookies, and does not attempt DRM or authentication bypasses. It applies request limits, a download-size limit and a processing-time limit. The service should be deployed in an isolated environment with restricted network egress before accepting untrusted public traffic; an initial URL check alone cannot fully control every secondary URL requested by third-party extractors.

### Build and test the API locally

~~~sh
cd server
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
python -m unittest -v test_app
uvicorn app:app --host 0.0.0.0 --port 10000
~~~

FFmpeg and Deno must be installed for the full extraction/conversion feature set. The Dockerfile installs both automatically.

### Deploy the API on Render

1. Open the Render Dashboard and choose New → Blueprint.
2. Connect the sandeepdolai/Downloadmedia repository and select the main branch.
3. Render reads render.yaml and builds the Docker service.
4. Wait for GET /health to return {"ok":true,...}.
5. The Vercel frontend uses the service URL https://memorableday-downloader-api.onrender.com. If Render gives the service a different hostname, set Vercel's PUBLIC_DOWNLOADER_API_URL environment variable to that exact URL and redeploy the website.

The Blueprint currently uses Render's Free plan for initial testing. Render states free web services spin down after inactivity and are not suitable for production. Use a paid instance for reliable downloads, and increase CPU/RAM only after measuring real usage.

## Compatibility and operating limits

yt-dlp supports a large and changing list of websites, not literally every website. An extractor can stop working when a source website changes. Links that require login, private access, paid access or DRM are not supported by this service. Downloads must be authorized by the content owner and permitted by the source platform's terms.

This first multi-site version runs extraction synchronously with bounded in-process concurrency. A Redis-backed job queue, multiple worker instances, object storage and progress polling are future scaling work; they are not configured in this initial deployment.
