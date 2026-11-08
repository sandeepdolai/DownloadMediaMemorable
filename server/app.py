from __future__ import annotations

import asyncio
import ipaddress
import json
import mimetypes
import os
import re
import shutil
import socket
import tempfile
import time
import unicodedata
from collections import defaultdict, deque
from pathlib import Path
from threading import Lock
from urllib.parse import parse_qs, urlsplit

import yt_dlp
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask

SERVICE_NAME = "memorableday-downloader-api"
MAX_DOWNLOAD_BYTES = max(1, int(os.getenv("MAX_DOWNLOAD_MB", "300"))) * 1024 * 1024
MAX_DOWNLOAD_SECONDS = max(60, int(os.getenv("MAX_DOWNLOAD_SECONDS", "900")))
MAX_CONCURRENT_DOWNLOADS = max(1, int(os.getenv("MAX_CONCURRENT_DOWNLOADS", "2")))
SOCKET_TIMEOUT = max(5, int(os.getenv("YT_DLP_SOCKET_TIMEOUT", "20")))

ALLOWED_ORIGINS = [
    item.strip()
    for item in os.getenv(
        "ALLOWED_ORIGINS",
        "https://memorableday.in,https://www.memorableday.in,https://memorableday-in.vercel.app,http://localhost:4321",
    ).split(",")
    if item.strip()
]

app = FastAPI(
    title="MemorableDay Downloader API",
    version="2.0.0",
    docs_url=None,
    redoc_url=None,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type"],
    allow_credentials=False,
)

DOWNLOAD_SEMAPHORE = asyncio.Semaphore(MAX_CONCURRENT_DOWNLOADS)
RATE_BUCKETS: dict[tuple[str, str], deque[float]] = defaultdict(deque)
RATE_LOCK = Lock()


class InspectRequest(BaseModel):
    url: str = Field(min_length=8, max_length=4096)


def enforce_rate_limit(request: Request, action: str) -> None:
    limits = {"inspect": (20, 60), "download": (6, 60)}
    limit, window_seconds = limits[action]
    client_ip = request.client.host if request.client else "unknown"
    now = time.monotonic()
    key = (client_ip, action)
    with RATE_LOCK:
        bucket = RATE_BUCKETS[key]
        while bucket and now - bucket[0] >= window_seconds:
            bucket.popleft()
        if len(bucket) >= limit:
            raise HTTPException(
                status_code=429,
                detail="Too many requests. Please wait a moment and try again.",
            )
        bucket.append(now)


def validate_public_url(value: str) -> str:
    if not isinstance(value, str) or len(value) > 4096:
        raise HTTPException(status_code=400, detail="Enter a valid media link.")

    try:
        parsed = urlsplit(value.strip())
        hostname = parsed.hostname
        port = parsed.port
    except ValueError:
        raise HTTPException(status_code=400, detail="Enter a valid media link.")

    if parsed.scheme.lower() not in {"http", "https"} or not hostname:
        raise HTTPException(status_code=400, detail="Only public HTTP or HTTPS links are supported.")
    if parsed.username or parsed.password:
        raise HTTPException(status_code=400, detail="Links containing embedded credentials are not supported.")
    if port and port not in {80, 443}:
        raise HTTPException(status_code=400, detail="Non-standard ports are not supported.")

    host = hostname.rstrip(".").lower()
    if (
        host in {"localhost", "metadata.google.internal"}
        or host.endswith((".localhost", ".local", ".internal", ".test", ".invalid"))
    ):
        raise HTTPException(status_code=400, detail="Private and local network links are not allowed.")

    try:
        try:
            addresses = [ipaddress.ip_address(host)]
        except ValueError:
            records = socket.getaddrinfo(host, port or (443 if parsed.scheme == "https" else 80), type=socket.SOCK_STREAM)
            addresses = list({ipaddress.ip_address(record[4][0].split("%", 1)[0]) for record in records})
    except (OSError, ValueError):
        raise HTTPException(status_code=422, detail="The website address could not be resolved.")

    if not addresses or any(not address.is_global for address in addresses):
        raise HTTPException(status_code=400, detail="Links to private or reserved network addresses are not allowed.")

    return value.strip()


def _video_formats(info: dict) -> list[dict]:
    formats = info.get("formats") or []
    return [item for item in formats if item.get("vcodec") not in (None, "none")]


def _audio_formats(info: dict) -> list[dict]:
    formats = info.get("formats") or []
    return [item for item in formats if item.get("acodec") not in (None, "none")]


def build_format_options(info: dict) -> list[dict[str, str | bool]]:
    if info.get("_type") in {"playlist", "multi_video"} or info.get("entries"):
        raise HTTPException(
            status_code=422,
            detail="This link contains a playlist. Please paste a link to one individual video or audio item.",
        )

    video_formats = _video_formats(info)
    audio_formats = _audio_formats(info)
    if not video_formats and info.get("vcodec") not in (None, "none"):
        video_formats = [info]
    if not audio_formats and info.get("acodec") not in (None, "none"):
        audio_formats = [info]

    heights = sorted(
        {
            int(item["height"])
            for item in video_formats
            if isinstance(item.get("height"), (int, float)) and 0 < int(item["height"]) <= 4320
        },
        reverse=True,
    )

    options: list[dict[str, str | bool]] = []
    if video_formats:
        highest = heights[0] if heights else None
        best_label = f"Best available video ({highest}p)" if highest else "Best available video"
        options.append({"id": "best", "label": best_label, "available": True})
        for height in heights[1:6]:
            options.append({"id": f"p{height}", "label": f"{height}p video", "available": True})
    elif audio_formats:
        options.append({"id": "audio", "label": "Original audio", "available": True})

    if audio_formats:
        options.append({"id": "mp3", "label": "MP3 audio · 192 kbps", "available": True})

    if not options:
        raise HTTPException(
            status_code=422,
            detail="No downloadable audio or video formats were found for this link.",
        )
    return options


def _format_plan(format_id: str, info: dict) -> dict:
    available_ids = {str(item["id"]) for item in build_format_options(info)}
    if format_id not in available_ids:
        raise HTTPException(status_code=400, detail="Choose one of the formats shown for this link.")

    if format_id == "best":
        return {"format": "bestvideo+bestaudio/best"}
    if format_id == "audio":
        return {"format": "bestaudio/best"}
    if format_id == "mp3":
        return {
            "format": "bestaudio/best",
            "postprocessors": [
                {
                    "key": "FFmpegExtractAudio",
                    "preferredcodec": "mp3",
                    "preferredquality": "192",
                }
            ],
        }

    match = re.fullmatch(r"p([0-9]{2,4})", format_id)
    if match:
        height = int(match.group(1))
        if not 144 <= height <= 4320:
            raise HTTPException(status_code=400, detail="That video resolution is not available.")
        return {
            "format": f"bestvideo[height<={height}]+bestaudio/best[height<={height}]"
        }

    raise HTTPException(status_code=400, detail="Choose a supported download format.")


class QuietLogger:
    def debug(self, _message: str) -> None:
        pass

    def info(self, _message: str) -> None:
        pass

    def warning(self, _message: str) -> None:
        pass

    def error(self, _message: str) -> None:
        pass


def ydl_base_options() -> dict:
    return {
        "quiet": True,
        "no_warnings": True,
        "no_color": True,
        "ignoreconfig": True,
        "noplaylist": True,
        "socket_timeout": SOCKET_TIMEOUT,
        "retries": 1,
        "fragment_retries": 1,
        "extractor_retries": 1,
        "cachedir": False,
        "restrictfilenames": True,
        "logger": QuietLogger(),
        "geo_bypass": False,
        "nocheckcertificate": False,
        "max_downloads": 1,
    }


def extract_metadata(url: str) -> dict:
    options = ydl_base_options()
    options["skip_download"] = True
    try:
        with yt_dlp.YoutubeDL(options) as downloader:
            info = downloader.extract_info(url, download=False)
    except yt_dlp.utils.DownloadError as error:
        raise HTTPException(status_code=422, detail=friendly_extractor_error(str(error)))
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(
            status_code=502,
            detail="The website could not provide media details. Try another link later.",
        )

    if not isinstance(info, dict):
        raise HTTPException(status_code=422, detail="No media information was returned for this link.")
    return info


def friendly_extractor_error(message: str) -> str:
    lowered = message.lower()
    if any(term in lowered for term in ("private video", "login", "sign in", "authentication", "members-only")):
        return "This media requires an account or permission that MemorableDay does not have."
    if any(term in lowered for term in ("unsupported url", "no suitable extractor", "not a valid url")):
        return "This website or link is not currently supported by the extraction engine."
    if any(term in lowered for term in ("drm", "widevine", "fairplay", "playready")):
        return "This media is DRM-protected and cannot be processed."
    if "http error 403" in lowered or "forbidden" in lowered:
        return "The website refused this request. Its content is not available to this downloader."
    if "video unavailable" in lowered or "not available" in lowered:
        return "This media is unavailable from the source website."
    return "The website could not provide this media. It may be unsupported, unavailable, or access-restricted."


def inspect_media(url: str) -> dict:
    info = extract_metadata(url)
    formats = build_format_options(info)
    raw_formats = info.get("formats") or []
    size_candidates = [
        item.get("filesize") or item.get("filesize_approx")
        for item in raw_formats
        if item.get("filesize") or item.get("filesize_approx")
    ]
    size_bytes = max((int(value) for value in size_candidates if value), default=0) or None

    has_video = bool(_video_formats(info)) or info.get("vcodec") not in (None, "none")
    content_type = "video" if has_video else "audio"
    return {
        "ok": True,
        "title": str(info.get("title") or "Media ready")[:180],
        "contentType": content_type,
        "sizeBytes": size_bytes,
        "duration": info.get("duration"),
        "extractor": info.get("extractor_key") or info.get("extractor"),
        "formats": formats,
    }


def safe_filename(value: str, extension: str) -> str:
    title = unicodedata.normalize("NFKC", value or "memorableday-download")
    title = re.sub(r'[\x00-\x1f<>:"/\\|?*]+', "_", title)
    title = re.sub(r"\s+", " ", title).strip(" .")[:110]
    if not title:
        title = "memorableday-download"
    suffix = extension if extension.startswith(".") else f".{extension}" if extension else ".media"
    return f"{title}{suffix.lower()}"


def download_to_temp(url: str, format_id: str) -> tuple[str, str, str]:
    metadata = extract_metadata(url)
    plan = _format_plan(format_id, metadata)
    temp_dir = tempfile.mkdtemp(prefix="memorableday-")
    output_template = str(Path(temp_dir) / "download.%(ext)s")
    started = time.monotonic()

    def progress_hook(data: dict) -> None:
        if time.monotonic() - started > MAX_DOWNLOAD_SECONDS:
            raise yt_dlp.utils.DownloadError("The download exceeded the configured time limit.")
        downloaded = int(data.get("downloaded_bytes") or 0)
        if downloaded > MAX_DOWNLOAD_BYTES:
            raise yt_dlp.utils.DownloadError("The download exceeded the configured file-size limit.")

    options = ydl_base_options()
    options.update(
        {
            "format": plan["format"],
            "outtmpl": output_template,
            "max_filesize": MAX_DOWNLOAD_BYTES,
            "nopart": True,
            "overwrites": True,
            "progress_hooks": [progress_hook],
        }
    )
    if plan.get("postprocessors"):
        options["postprocessors"] = plan["postprocessors"]

    try:
        with yt_dlp.YoutubeDL(options) as downloader:
            downloader.extract_info(url, download=True)

        candidates = [
            item
            for item in Path(temp_dir).glob("download.*")
            if item.is_file() and item.suffix not in {".part", ".ytdl"}
        ]
        if not candidates:
            raise HTTPException(status_code=502, detail="The source did not produce a downloadable file.")
        output_path = max(candidates, key=lambda item: item.stat().st_size)
        size = output_path.stat().st_size
        if size <= 0:
            raise HTTPException(status_code=502, detail="The downloaded file is empty.")
        if size > MAX_DOWNLOAD_BYTES:
            raise HTTPException(status_code=413, detail="The media exceeds the current download-size limit.")

        title = str(metadata.get("title") or "memorableday-download")
        filename = safe_filename(title, output_path.suffix)
        media_type = mimetypes.guess_type(output_path.name)[0] or "application/octet-stream"
        return temp_dir, str(output_path), f"{filename}|{media_type}"
    except yt_dlp.utils.DownloadError as error:
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise HTTPException(status_code=422, detail=friendly_extractor_error(str(error)))
    except HTTPException:
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise
    except Exception:
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise HTTPException(status_code=502, detail="The media could not be downloaded. Please try again.")


async def parse_download_request(request: Request) -> tuple[str, str]:
    if request.headers.get("content-length") and int(request.headers["content-length"]) > 16_384:
        raise HTTPException(status_code=413, detail="The download request is too large.")
    body = await request.body()
    content_type = request.headers.get("content-type", "").lower()
    try:
        if "application/json" in content_type:
            payload = json.loads(body or b"{}")
        else:
            values = parse_qs(body.decode("utf-8"), keep_blank_values=True)
            payload = {key: items[-1] for key, items in values.items()}
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
        raise HTTPException(status_code=400, detail="The download request is invalid.")

    url = payload.get("url") if isinstance(payload, dict) else None
    format_id = payload.get("format", "best") if isinstance(payload, dict) else "best"
    if not isinstance(url, str) or not isinstance(format_id, str):
        raise HTTPException(status_code=400, detail="Provide a media link and format.")
    return validate_public_url(url), format_id


@app.exception_handler(HTTPException)
async def http_error_handler(_request: Request, error: HTTPException) -> JSONResponse:
    return JSONResponse(
        status_code=error.status_code,
        content={"error": str(error.detail)},
        headers=error.headers,
    )


@app.exception_handler(Exception)
async def unexpected_error_handler(_request: Request, _error: Exception) -> JSONResponse:
    return JSONResponse(
        status_code=500,
        content={"error": "The download service encountered a problem. Please try again."},
    )


@app.get("/health")
async def health() -> dict:
    return {
        "ok": True,
        "service": SERVICE_NAME,
        "engine": getattr(yt_dlp.version, "__version__", "unknown"),
    }


@app.post("/v1/inspect")
async def inspect_endpoint(payload: InspectRequest, request: Request) -> dict:
    enforce_rate_limit(request, "inspect")
    url = validate_public_url(payload.url)
    return await asyncio.to_thread(inspect_media, url)


@app.post("/v1/download")
async def download_endpoint(request: Request):
    enforce_rate_limit(request, "download")
    url, format_id = await parse_download_request(request)

    async with DOWNLOAD_SEMAPHORE:
        temp_dir, output_path, details = await asyncio.to_thread(download_to_temp, url, format_id)

    filename, media_type = details.split("|", 1)
    return FileResponse(
        output_path,
        media_type=media_type,
        filename=filename,
        headers={
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        },
        background=BackgroundTask(shutil.rmtree, temp_dir, ignore_errors=True),
    )
