# TrguiNG Link Helper

Small NAS-side HTTP helper for manual symlink repair from TrguiNG.

## Endpoints

- `GET /health`
- `POST /search-candidates`
- `POST /create-symlink`

## Environment variables

- `HOST`: bind address, default `0.0.0.0`
- `PORT`: listen port, default `8787`
- `API_TOKEN`: optional bearer token
- `ALLOWED_ROOTS`: comma-separated whitelist of writable roots, default `/downloads`
- `SEARCH_ROOTS`: comma-separated extra search roots, optional
- `CANDIDATE_LIMIT`: max returned candidates, default `20`
- `MIN_SCORE`: candidate similarity threshold, default `0.35`
- `AUTO_CREATE_TARGET_PARENT`: `true` or `false`, default `true`

## Docker example

```yaml
services:
  trguing-link-helper:
    image: lc121a/trguing-link-helper:latest
    container_name: trguing-link-helper
    restart: unless-stopped
    environment:
      PORT: "8787"
      API_TOKEN: "replace-me"
      ALLOWED_ROOTS: "/downloads,/media"
      SEARCH_ROOTS: "/downloads,/media/torrents"
    volumes:
      - /volume1/downloads:/downloads
      - /volume1/media:/media
    ports:
      - "8787:8787"
```

Mount the same paths that Transmission uses inside its container.

Ready-made compose example:

- [docker-compose.example.yml](/C:/Users/Admin/projects/TrguiNG/link-helper/docker-compose.example.yml)

## Example requests

Search:

```bash
curl -H "Authorization: Bearer replace-me" \
  -H "Content-Type: application/json" \
  -d '{"torrentName":"Movie.Name.2024.1080p.BluRay","downloadDir":"/downloads/movies","targetPath":"/downloads/movies/Movie.Name.2024.1080p.BluRay"}' \
  http://nas-host:8787/search-candidates
```

Create:

```bash
curl -H "Authorization: Bearer replace-me" \
  -H "Content-Type: application/json" \
  -d '{"sourcePath":"/downloads/movies/Movie Name 2024","targetPath":"/downloads/movies/Movie.Name.2024.1080p.BluRay"}' \
  http://nas-host:8787/create-symlink
```
