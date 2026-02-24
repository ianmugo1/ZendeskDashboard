# Emerald Park IT Ticket Dashboard

Internal dashboard stack for Zendesk operational metrics.

## Repo layout

- `apps/dashboard-ui`: Next.js App Router UI (Tailwind, dark TV layout, basic auth, 20s refresh).
  - `/`: management KPI dashboard
  - `/audit`: solved tickets audit page with agent + keyword filtering
- `apps/metrics-api`: Express API that serves cached snapshot from Redis or file cache.
- `apps/worker`: polling worker that aggregates Zendesk metrics every 60+ seconds.
- `packages/zendesk-client`: typed Zendesk API wrapper with auth + retry/backoff.
- `config/dashboard.config.json`: config file for tags/groups/views.

## What is implemented

- Caching is mandatory and enforced: worker writes one snapshot payload to cache (`redis` key or local snapshot file).
- Zendesk is never called from the browser.
- Poll frequency is clamped to a minimum of 60 seconds.
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

## API endpoints

- `GET /health` (metrics API): service + cache backend health.
- `GET /api/metrics/snapshot` (metrics API): current cached dashboard payload.
- `GET /api/metrics/summary/daily` (metrics API): daily compliance summary slice.
- `GET /api/metrics/screenshot/latest` (metrics API): latest PNG screenshot for Teams cards.
- `GET /api/metrics/export/:dataset` (metrics API): CSV exports (`agent-performance`, `solved-tickets-7d`, `reopened-tickets-30d`, `group-workload`, `high-priority-risk`, `daily-summary`).
- `GET /api/snapshot` (dashboard UI): proxy to metrics API for browser refresh.
- `GET /api/export/:dataset` (dashboard UI): proxy CSV download endpoint.

## Config knobs

- `.env`:
  - `POLL_INTERVAL_SECONDS` (minimum 20)
  - `DASHBOARD_TIMEZONE`
  - `SNAPSHOT_STALE_AFTER_SECONDS`
  - `CACHE_BACKEND` (`redis` or `file`)
  - `SNAPSHOT_FILE_PATH`
  - `MAX_TICKET_SCAN`
  - `MAX_SOLVED_AUDIT_TICKETS`
  - `MAX_AGENT_SCAN`
  - `TICKETS_BY_TAG_LIST`
  - `DASHBOARD_REFRESH_SECONDS`
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
  - `METRICS_PUBLIC_BASE_URL`
  - `DASHBOARD_PUBLIC_URL`
  - `TEAMS_NOTIFICATIONS_ENABLED`
  - `TEAMS_WEBHOOK_URL`
  - `TEAMS_NOTIFY_INTERVAL_SECONDS`
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
