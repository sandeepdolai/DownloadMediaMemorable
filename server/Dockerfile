FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    TMPDIR=/tmp/memorableday

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg unzip \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /opt/deno /app /tmp/memorableday \
    && curl -fsSL https://deno.land/install.sh -o /tmp/deno-install.sh \
    && DENO_INSTALL=/opt/deno sh /tmp/deno-install.sh v2.6.1 \
    && ln -s /opt/deno/bin/deno /usr/local/bin/deno \
    && rm -f /tmp/deno-install.sh

WORKDIR /app
COPY requirements.txt ./
RUN pip install --upgrade pip \
    && pip install -r requirements.txt

COPY app.py test_app.py ./
RUN python -m compileall -q app.py test_app.py \
    && python -m unittest -v test_app

RUN useradd --create-home --uid 10001 appuser \
    && chown -R appuser:appuser /app /tmp/memorableday
USER appuser

ENV PORT=10000
EXPOSE 10000

CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port \"$PORT\" --proxy-headers --forwarded-allow-ips='*'"]
