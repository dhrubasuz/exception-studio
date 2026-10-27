# Security scope

Maintainer: **Dhruba Poudel** · Last reviewed: **28 October 2026**

Exception Studio is a public portfolio lab using **fictional data and fictional accounts**. Do not enter employer, customer, personal, financial or confidential information, including in reasons. Team Edition and Classic have different account models; neither is an enterprise identity or records service.

## Implemented controls

- Random Team passwords are displayed once and stored as salted scrypt hashes. Session tokens use 32 random bytes; only SHA-256 token hashes are stored. Roles come from database records, never client labels or supplied role fields.
- Cookies are `HttpOnly`, `SameSite=Lax` and host-only. HTTPS `PUBLIC_ORIGIN` uses `__Host-est_actor; Secure; Path=/`. Classic uses a separate capability cookie.
- Workspace expiry and ownership scope authenticated queries. Cross-workspace jobs/traces return `404`. A distinct approver account is required after analyst submission.
- Browser mutations require an allowed `Origin`, JSON content type and bounded body. No wildcard CORS. Sign-in and workspace creation have additional request limits.
- State, audit entries and command retry records commit transactionally. Human commands check the current job revision; altered reuse of an idempotency key returns `409`.
- Worker claims have expiring leases and random fencing tokens. A stale worker cannot complete a reclaimed attempt. Source snapshots are immutable after capture. Retries and replay generations are bounded.
- The worker only accepts loopback base URLs and fixed sandbox routes, protected by a process-generated secret and constant-time comparison. Visitors cannot choose an arbitrary connector URL or configure external credentials.
- Destination receipts deduplicate workspace/event pairs and retain a payload hash. A fixture deliberately commits before delaying its response, testing retry safety after an uncertain result.
- Static serving is confined to built assets, denying dot paths and common database/key-file extensions. CSP restricts scripts and connections to the same origin; framing and MIME sniffing are restricted. User text renders as text.
- Bounds: 24-hour workspaces; 200 active workspaces; 40 jobs/workspace; three attempts per phase/generation; three source generations; 1,000 commands; 100 successful logins and the latest 20 sessions/account.

Automated tests exercise specified boundaries, including Classic regressions. They do not establish security certification or immunity from every attack.

## Trust boundaries and limitations

**Accounts are fictional.** One visitor receives both and can sign in as either. Distinct account decisions demonstrate permissions, not independent human approval. There is no SSO, MFA, organisation verification or recovery. Credential kits are memory-only in the browser and disappear on reload unless saved.

**The operator is trusted.** Someone able to alter database/schema/application files can alter the system and history. Triggers guard normal writes; hashes identify bytes and do not prove truth or independent approval.

**Delivery safety depends on destination behaviour.** This sandbox deduplicates stable event IDs. External APIs may not. This release does not connect to real business/payment APIs or guarantee global exactly-once delivery.

**Persistence depends on hosting storage.** Restart recovery needs the same SQLite file. Redeployments or storage replacement may reset the demo. Backups, disaster recovery and production migrations are not included. Run one Node instance; this is not a distributed queue.

**Expiry is not secure erasure.** Access ends after 24 hours; creation/periodic cleanup removes rows. Journals, free pages, infrastructure logs or backups may retain information. No secure-deletion guarantee is made.

**Limits are modest.** In-process peer-IP counters reset on restart and may aggregate visitors behind a proxy. Synchronous password hashing and SQLite suit a small demo, not high throughput or production abuse defence.

**Observability is local.** Persisted durations and trace/span IDs support inspection. No OpenTelemetry backend, production alerting or independent audit service is installed. Reload restores the cookie session but not unsaved credentials or edits.

## Hosting and reporting

Use HTTPS, exact `PUBLIC_ORIGIN`, the required bind interface and `DATABASE_PATH` outside `dist/client`. Keep databases, logs, `.env`, hosting credentials and temporary artifacts out of source archives. Restrict host access separately. The worker secret is generated at startup and never sent to the browser.

Before real-data use, separately review identity, privacy, retention, migrations, abuse handling, monitoring, backups, scaling and every real connector's delivery contract. No real-data readiness claim is made.

Contact **Dhruba Poudel** through [about.dhrub.com.np](https://about.dhrub.com.np/) with a minimal fictional-data reproduction. Never put credentials, session tokens or private information in public issues; request a private channel first. Live testing must stay inside your own workspace and normal limits, without bulk account creation or exhausting the host.
