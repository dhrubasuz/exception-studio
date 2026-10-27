# Exception Studio · Team Edition

**A connector failure should become a recoverable job, with an accountable decision before delivery.**

Exception Studio is a working, full-stack reliability lab. Break a fictional connector, inspect its persisted attempts, repair a changed payload as an analyst, and authorise delivery with a separate approver account. A background worker uses actual HTTP requests, a durable SQLite queue and a destination receipt ledger to make recovery inspectable.

Created and maintained by **Dhruba Poudel** · React · TypeScript · Node.js 24 · SQLite.

**[Live Team Edition](https://studio.dhrub.com.np/)** · [Classic import workbench](https://studio.dhrub.com.np/classic) · [Automated checks](https://github.com/dhrubasuz/exception-studio/actions) · [Security boundaries](SECURITY.md)

## Explore a failure, then prove the recovery

1. Create a fictional workspace, which signs you in as **Avery, the analyst**. Save its one-time demo credential kit if you want to switch accounts after reloading.
2. Queue a scenario. Watch actual persisted source attempts and retry deadlines.
3. Review the source or repair schema drift, then submit the payload with a reason.
4. Switch to **Sam, the approver**, inspect the payload and approve delivery with a reason.
5. Inspect the destination receipt, actor history and downloadable JSON trace.
6. Try **lost delivery response**: the destination commits before the first response times out. Its retry returns the existing receipt, without writing a duplicate.

Both accounts belong to a private, 24-hour fictional workspace. A single visitor controls both accounts; this demonstrates server-enforced roles and distinct account decisions, **not independently verified people or an enterprise identity service**. Do not enter real business or personal data.

| Scenario | Observable behaviour |
| --- | --- |
| Healthy connector | Valid source → analyst review → approver decision → one receipt |
| Rate limit | HTTP 429 twice; worker respects `Retry-After` before the third source request succeeds |
| Source timeout | First response exceeds the request deadline; retry succeeds using the same job |
| Schema drift | Invalid source shape is preserved; analyst supplies a validated correction and reason |
| Duplicate event | Repeating the fixed source event does not create another job |
| Upstream outage | Bounded 503 retries reach dead letter; analyst explicitly restores the fictional connector and replays |
| Lost delivery response | Receipt is committed before timeout; retry returns that receipt, with one destination write |

See the [guided demo](docs/TEAM_DEMO.md) and [architecture](docs/TEAM_ARCHITECTURE.md).

## Engineering decisions

| Concern | Implemented boundary |
| --- | --- |
| Identity and roles | Workspace-scoped demo users, salted scrypt password hashes, hashed session tokens, server-side analyst/approver checks |
| Queue durability | SQLite state, claim leases, lease-token fencing and expired-lease recovery; HTTP runs outside transactions |
| Command uncertainty | Idempotency key binds actor, route and canonical body; identical retries reuse the command, altered reuse returns `409` |
| Concurrent decisions | Job revision checked inside a transaction; stale decisions fail without partially applying |
| External side effects | Fixed, authenticated loopback HTTP sandbox; destination deduplicates stable source event IDs, including commit-before-timeout |
| Human review | Source validation never approves a payload; analyst submission and separate approver authorisation are explicit |
| Evidence | Source hash, attempt durations, trace/span IDs, actor events, job revisions and receipt payload hashes |
| Isolation | Workspace ownership filters, expiry, bounded jobs/attempts/commands/sessions and origin checks |

The delivery path provides **at-least-once attempts with destination deduplication** within this controlled sandbox. It does not promise exactly-once delivery across arbitrary APIs. The custom trace viewer is not an OpenTelemetry collector or a distributed monitoring installation.

## Run locally

Use **Node.js 24** and **pnpm 11.25.0**. No cloud account, API key or paid database is required.

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm build
pnpm start
```

Open `http://127.0.0.1:8080`. Team Edition is the default; `/classic` retains the original import/reconciliation/export workflow. For client development, run the built server with `PORT=65457` and `PUBLIC_ORIGIN=http://127.0.0.1:65458`, then run `pnpm dev` in a separate terminal. Vite serves `http://127.0.0.1:65458` and proxies `/api`. Use your shell's environment-variable syntax.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address; use the hosting platform's required interface |
| `PUBLIC_ORIGIN` | Request Host origin | Exact browser origin; use HTTPS in deployment to enable secure host-only cookies |
| `DATABASE_PATH` | `data/exception-studio.sqlite` | SQLite file outside public client assets |
| `DEMO_ONLY` | `true` | Classic scope label; neither mode enables arbitrary uploads |

Run one Node instance against its local SQLite file. Restarts preserve state when the file survives; storage replacement or redeployment may reset the public demo. Account recovery, SSO, backups and external connector credentials are outside this release.

## Verification

`pnpm test` exercises database and HTTP boundaries using real SQLite and HTTP, followed by interface tests. The release check on 28 October 2026 passed **95 tests**: 68 domain/store/HTTP tests and 27 interface tests. CI also checks formatting, builds the complete app and audits production dependencies. The [HTTP verification notes](docs/TEAM-HTTP-VERIFICATION.md) record its scope.

A passing check is evidence for its specified behaviour, not a guarantee that every failure has been eliminated. Technical timings come from fictional test traffic; no business savings or customer results are claimed.

## Classic edition

The original workbench preserves a 22-row fictional import, requires explicit exception decisions, reconciles every row and freezes CSV/manifest bytes. Its [walkthrough](docs/DEMO.md), [architecture](docs/ARCHITECTURE.md) and [release description](docs/CLASSIC.md) remain available. Those documents describe Classic's anonymous capability cookie, not Team Edition's account model.

MIT license · **Dhruba Poudel**.
