# Emerald Park IT Ticket Dashboard

Internal dashboard stack for Zendesk operational metrics.

## Repo layout

- `apps/dashboard-ui`: Next.js App Router UI (Tailwind, dark TV layout, basic auth, configurable refresh).
  - `/`: management KPI dashboard
  - `/audit`: solved tickets audit page with agent + keyword filtering
- `apps/metrics-api`: Express API that serves cached snapshot from Redis or file cache.
- `apps/worker`: polling worker with light and heavy refresh modes for Zendesk aggregation.
- `packages/zendesk-client`: typed Zendesk API wrapper with auth + retry/backoff.
- `config/dashboard.config.json`: config file for tags/groups/views.

## What is implemented

- Caching is mandatory and enforced: worker writes one snapshot payload to cache (`redis` key or local snapshot file).
- Zendesk is never called from the browser.
- Poll frequency is clamped to a minimum of 20 seconds.
- Heavy snapshot sections can refresh on a separate, slower cadence (`HEAVY_REFRESH_INTERVAL_SECONDS`).
- Metrics in snapshot:
  - `unsolved_count`
  - `daily_tickets` (`today`, `yesterday`, `last_7_days`)
  - `sla_health_7d` (first-response proxy + resolution target health)
  - `backlog_aging` (`under_24h`, `1-3d`, `3-7d`, `>7d`)
  - `unassigned_tickets` (top 10)
  - `top_solvers` (top 5 in last 7 days)
  - `attention_tickets` (top 15 new/open high/urgent)
  - `agent_audit` (solved counts by agent)
  - `all_agents` (full Zendesk agent directory with solved counts)
  - `agent_performance_7d` (solved, resolution median/SLA %, reopen proxy, backlog)
  - `solved_tickets_7d` (filterable solved ticket rows)
  - `reopened_tickets_30d` (currently unsolved tickets that were solved in last 30 days)
  - `assignment_lag` (unassigned aging and oldest unassigned rows)
  - `group_workload` (open/solved/high-priority open by group)
  - `high_priority_risk_tickets` (high/urgent with stale update age)
  - `trends_30d` (intake/solved/backlog estimate/SLA % by day)
  - `tickets_by_tag` (from config/env list)
  - `daily_summary` (compliance snapshot for current day)
  - `alerts` (server-side threshold summary for unsolved, attention, unassigned)
- Operational hardening:
  - structured logs (Pino)
  - retry with exponential backoff for Zendesk `429`/`5xx`
  - `/health` endpoint in metrics API
  - centralized API error handler
  - snapshot timestamp (`generated_at`) surfaced in UI
  - timezone-aware daily windows (`DASHBOARD_TIMEZONE`, default `Europe/Dublin`)
  - runtime snapshot schema validation before cache write
  - stale snapshot rejection (`503`) in metrics API
  - basic auth for dashboard via env vars

## Prerequisites

- Node.js 20+
- Optional: Docker if you want Redis backend

## Setup

1. Copy env file and set real Zendesk credentials:

```bash
cp .env.example .env
```

2. Pick cache backend in `.env`:

- `CACHE_BACKEND=redis` (default) for Redis
- `CACHE_BACKEND=file` for Docker-free local file cache

3. If using Redis, start it:

```bash
docker compose up -d redis
```

4. Install dependencies:

```bash
npm install
```

## Run locally

### Start services together

```bash
npm run dev
```

This runs:

- metrics API on `http://localhost:4000`
- worker loop in background
- dashboard UI on `http://localhost:3000`

### Start services separately

```bash
npm run dev:api
npm run dev:worker
npm run dev:dashboard
```

## Production deployment (desktop + mobile access)

This repo includes a production Docker stack with HTTPS termination:

- `docker-compose.prod.yml`
- `docker/dashboard-ui.Dockerfile`
- `docker/metrics-api.Dockerfile`
- `docker/worker.Dockerfile`
- `deploy/Caddyfile`
- `.env.production.example`

### Deploy steps

1. Copy production env template and set real values/secrets:

```bash
cp .env.production.example .env.production
```

2. Set at minimum:

- `DASHBOARD_DOMAIN` (public DNS name)
- Zendesk credentials (`ZENDESK_*`)
- dashboard auth credentials (`DASHBOARD_BASIC_AUTH_*`, optionally analyst/admin)
- `METRICS_API_TOKEN` (required for internal API protection)
- rotate all `change-me` passwords/tokens before first deploy (deploy script now blocks placeholders)

3. Point your domain DNS A record to the server IP.

4. Start stack:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```

Or use:

```bash
./scripts/deploy-prod.sh
```

5. Open `https://<your-domain>` on desktop or mobile.

### Updating deployment

```bash
git pull
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```

### Backup data

Create a backup archive of `/app/data` from the running metrics container:

```bash
./scripts/backup-dashboard-data.sh
```

This outputs a timestamped archive under `backups/`.

## API endpoints

- `GET /health` (metrics API): service + cache backend health.
- `GET /api/metrics/snapshot` (metrics API): current cached dashboard payload.
- `GET /api/metrics/summary/daily` (metrics API): daily compliance summary slice.
- `GET /api/metrics/worker-status` (metrics API): worker health, failures, and last successful poll.
- `GET /api/metrics/history/daily` (metrics API): Supabase-backed historical snapshot series.
- `GET /api/metrics/history/worker-runs` (metrics API): Supabase-backed worker run reliability series.
- `GET /api/metrics/audit/solved` (metrics API): server-side paginated solved-ticket audit rows.
- `POST /api/metrics/refresh` (metrics API): request an immediate heavy refresh from worker.
- `GET /api/metrics/screenshot/latest` (metrics API): latest PNG screenshot for Teams cards.
- `GET /api/metrics/export/:dataset` (metrics API): CSV exports (`agent-performance`, `solved-tickets-7d`, `reopened-tickets-30d`, `group-workload`, `high-priority-risk`, `daily-summary`).
- `GET /api/snapshot` (dashboard UI): proxy to metrics API for browser refresh.
- `GET /api/export/:dataset` (dashboard UI): proxy CSV download endpoint.
- `POST /api/refresh` (dashboard UI): proxy refresh trigger endpoint.
- `GET /api/history/daily` (dashboard UI): proxy history daily endpoint.
- `GET /api/history/worker-runs` (dashboard UI): proxy worker runs history endpoint.
- `GET/POST/DELETE /api/audit/presets` (dashboard UI): shared saved filter presets for audit page.

## Config knobs

- `.env`:
  - `POLL_INTERVAL_SECONDS` (minimum 20)
  - `HEAVY_REFRESH_INTERVAL_SECONDS` (minimum `POLL_INTERVAL_SECONDS`)
  - `ZENDESK_RATE_LIMIT_LOW_WATERMARK`
  - `ZENDESK_RATE_LIMIT_CRITICAL_WATERMARK`
  - `SNAPSHOT_LOCK_KEY` (redis poll lock key for single-active worker)
  - `REFRESH_REQUEST_FILE_PATH` (file signal used by API and worker for manual force refresh)
  - `DASHBOARD_TIMEZONE`
  - `SNAPSHOT_STALE_AFTER_SECONDS`
  - `METRICS_CORS_ORIGINS`
  - `METRICS_API_TOKEN`
  - `WORKER_STATUS_FILE_PATH`
  - `CACHE_BACKEND` (`redis` or `file`)
  - `SNAPSHOT_FILE_PATH`
  - `MAX_TICKET_SCAN`
  - `MAX_SOLVED_AUDIT_TICKETS`
  - `MAX_AGENT_SCAN`
  - `TICKETS_BY_TAG_LIST`
  - `DASHBOARD_REFRESH_SECONDS`
  - `DASHBOARD_ANALYST_AUTH_USERNAME` / `DASHBOARD_ANALYST_AUTH_PASSWORD` (optional analyst role)
  - `DASHBOARD_ADMIN_AUTH_USERNAME` / `DASHBOARD_ADMIN_AUTH_PASSWORD` (optional: required for `/api/export/*`)
  - `NEXT_PUBLIC_ZENDESK_BASE_URL`
  - `WIDGETS_TOP_SOLVERS`
  - `WIDGETS_TICKETS_BY_TAG`
  - `WIDGETS_UNASSIGNED`
  - `WIDGETS_ATTENTION`
  - `WIDGETS_DAILY_VOLUME`
  - `THRESHOLD_UNSOLVED_WARN`
  - `THRESHOLD_ATTENTION_WARN`
  - `THRESHOLD_UNASSIGNED_WARN`
  - `SLA_FIRST_RESPONSE_TARGET_HOURS`
  - `SLA_RESOLUTION_TARGET_HOURS`
  - `HIGH_PRIORITY_STALE_HOURS`
  - `DIRECTORY_CACHE_TTL_SECONDS`
  - `METRICS_PUBLIC_BASE_URL`
  - `DASHBOARD_PUBLIC_URL`
  - `TEAMS_NOTIFICATIONS_ENABLED`
  - `TEAMS_WEBHOOK_URL`
  - `TEAMS_NOTIFY_INTERVAL_SECONDS`
  - `TEAMS_NOTIFY_ON_ALERT_CHANGE_ONLY`
  - `TEAMS_NOTIFY_MAX_SILENCE_SECONDS`
  - `SCREENSHOT_CAPTURE_URL`
  - `SCREENSHOT_FILE_PATH`
  - `SCREENSHOT_PUBLIC_URL`
  - `SCREENSHOT_ACCESS_TOKEN`
  - `SCREENSHOT_BROWSER_PATH`
  - `SCREENSHOT_WIDTH`
  - `SCREENSHOT_HEIGHT`
  - `SCREENSHOT_TIMEOUT_MS`
  - `SCREENSHOT_BASIC_AUTH_USERNAME`
  - `SCREENSHOT_BASIC_AUTH_PASSWORD`
  - `DASHBOARD_BASIC_AUTH_USERNAME`
  - `DASHBOARD_BASIC_AUTH_PASSWORD`
  - `DASHBOARD_STALE_WARNING_SECONDS`
  - `METRICS_REQUEST_METRICS_WINDOW_SIZE`
- `config/dashboard.config.json`:
  - `tags`
  - `groupIds`
  - `viewIds`

## Teams screenshot posting

The worker can post an Adaptive Card to Teams with:

- latest KPI facts
- screenshot image
- `Open Dashboard` link

Setup:

1. Create a Teams workflow webhook URL for your channel.
2. Set:
   - `TEAMS_NOTIFICATIONS_ENABLED=true`
   - `TEAMS_WEBHOOK_URL=<your webhook>`
   - `DASHBOARD_PUBLIC_URL=<deployed dashboard url>`
3. Configure screenshot hosting:
   - easiest: set `METRICS_PUBLIC_BASE_URL` and optional `SCREENSHOT_ACCESS_TOKEN`
   - then Teams image URL auto-resolves to `/api/metrics/screenshot/latest`
4. Set capture target:
   - `SCREENSHOT_CAPTURE_URL=<reachable dashboard url for worker>`
   - if dashboard is basic-auth protected, set `SCREENSHOT_BASIC_AUTH_USERNAME/PASSWORD`
5. Ensure a headless-capable browser is available to the worker:
   - Edge/Chrome on Windows, or set `SCREENSHOT_BROWSER_PATH` explicitly.

## Build and typecheck

```bash
npm run typecheck
npm run build
```

## Supabase Phase 1 (history write-through)

The worker can optionally write historical records to Supabase while keeping Redis/file snapshot reads unchanged.

Set in `.env` or `.env.production`:

- `SUPABASE_ENABLED=true`
- `SUPABASE_HISTORY_ENABLED=true` (optional override for metrics-api history reads)
- `SUPABASE_URL=https://<project-ref>.supabase.co`
- `SUPABASE_SERVICE_ROLE_KEY=<service-role-key>`
- `SUPABASE_TABLE_SNAPSHOTS=snapshots`
- `SUPABASE_TABLE_WORKER_RUNS=worker_runs`
- `SUPABASE_TABLE_ALERT_EVENTS=alert_events`

Create tables in Supabase SQL editor using:

- `supabase/phase1_schema.sql`

Expected table columns:

- `snapshots`: `generated_at`, `snapshot_mode`, `core_generated_at`, `heavy_generated_at`, `unsolved_count`, `attention_count`, `active_alert_count`, `payload_json`
- `worker_runs`: `started_at`, `finished_at`, `duration_ms`, `success`, `error_message`, `snapshot_mode`, `poll_reason`, `rate_limit_remaining`, `rate_limit_limit`, `rate_limit_reset_seconds`
- `alert_events`: `generated_at`, `snapshot_mode`, `metric`, `label`, `current_value`, `threshold`, `active`

## Incident runbook

1. Check container health:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production ps
```

2. Check API and worker health:

```bash
curl -s https://<dashboard-domain>/api/metrics/worker-status
curl -s https://<dashboard-domain>/api/health
```

3. Trigger immediate full refresh:

```bash
curl -X POST https://<dashboard-domain>/api/refresh
```

4. If snapshot remains stale:
- check worker logs for rate-limit pressure and failed polls
- validate Zendesk credentials and subdomain
- scale poll intervals up temporarily to reduce API pressure
