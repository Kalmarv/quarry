FROM oven/bun:1 AS ui
WORKDIR /ui
COPY ui/package.json ui/bun.lock* ./
RUN bun install --frozen-lockfile || bun install
COPY ui/ ./
RUN bun run build

FROM oven/bun:1
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg p7zip-full unrar-free curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install
COPY src/ ./src/
COPY --from=ui /ui/dist ./ui/dist
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD curl -sf http://localhost:3000/api/health || exit 1
CMD ["bun", "run", "src/index.ts"]
