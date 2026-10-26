# Security scope

Maintainer: **Dhruba Poudel** · Last reviewed: **27 October 2026**

Exception Studio is a public portfolio demonstration for **bundled fictional data**. It is not an enterprise identity, approval or records-management service. Please do not enter personal, employer, customer, financial or confidential information, including in review reasons.

## Implemented controls

- Anonymous workspaces use opaque 32-byte random cookie tokens; SQLite stores their SHA-256 hashes. Sandbox IDs in JSON do not grant access.
- Cookies are `HttpOnly`, `SameSite=Lax` and host-only. With an HTTPS `PUBLIC_ORIGIN`, the cookie is `__Host-es_session` with `Secure` and `Path=/`.
- Mutations require an allowed `Origin`, JSON content type and bounded request body. There is no wildcard CORS policy.
- Reads and mutations resolve records and publications through the owning unexpired sandbox. Cross-sandbox object access returns `404`.
- SQL transactions combine decisions, validation, revision updates, events and idempotency results. Invalid or stale commands do not partially commit.
- SQL triggers reject normal updates to protected original source content and publication snapshots. Exports neutralise common spreadsheet formula prefixes.
- The static server is limited to its built client directory and denies dot-prefixed paths and common database/key-file extensions. The database path belongs outside that directory.
- A content security policy restricts scripts and connections to the same origin; inline styles are allowed for React style attributes. Framing and MIME sniffing are restricted. Notes render as text.
- Request, record, operation and active-sandbox limits bound this small demo. Default creation/mutation rate limits are in-process and return `429` with `Retry-After`.

These controls have automated checks for specified behaviours. They do not establish that every attack or operational failure has been covered.

## Trust boundaries and limitations

**A cookie is a capability, not verified identity.** Anyone holding a valid token can access its sandbox. There are no organisational accounts, roles, recovery workflow or independently verified reviewer names. “Decision history” records application actions and reasons, not a certified human approval.

**The server and database operator are trusted.** A person able to alter the database or application can change schema, files and recorded history. Source/publication triggers are guardrails, not protection from a privileged operator. SHA-256 values identify bytes; they do not prove data truth or independent approval.

**Persistence depends on hosting storage.** A normal process restart preserves records when the same SQLite file survives. Redeployment or storage replacement may reset a public demo. This project does not include an audited backup, restore or disaster-recovery service.

**Expiry is not secure erasure.** Access ends 24 hours after creation. Expired rows are removed when a new session triggers cleanup or the ten-minute timer runs. SQLite journals, database free pages, infrastructure logs, backups and copies may retain information. The project makes no secure-deletion guarantee.

**Rate limiting is deliberately modest.** New-session limits use the network peer seen by Node. Behind a proxy that can aggregate visitors. Counters reset with the process, and the app does not implement a distributed quota service or a production denial-of-service defence. Run a single instance against its local SQLite file.

**The app does not accept arbitrary files.** Both scope modes import only bundled fictional fixtures. That reduces exposure without removing input risk: reasons and correction values still reach the API and are validated. Turning `DEMO_ONLY` off changes the scope label; it does not enable uploads or make the service suitable for real data.

## Hosting checklist

Use HTTPS, set `PUBLIC_ORIGIN` to the exact external origin, bind to the host's required interface, and place `DATABASE_PATH` outside `dist/client`. Publish only the built client assets through static serving. Keep the database, environment files and logs out of version control and public downloads. Restrict host and database access independently of the application.

Before any real-data use, undertake a separate review of identity and access control, privacy and retention, database migrations, infrastructure boundaries, abuse handling, monitoring, dependency maintenance, backups and recovery. This repository does not claim that work is complete.

## Reporting a concern

For a potential vulnerability, contact **Dhruba Poudel** through the contact details at [about.dhrub.com.np](https://about.dhrub.com.np/). Describe the affected route, expected behaviour, observed result and a minimal fictional-data reproduction. Do not include session tokens, real personal information or secrets in a public issue. If a private reporting channel is unavailable, request one before sharing sensitive details.

Testing against the live demonstration should stay within your own sandbox and its normal limits. Do not access other visitors' workspaces, automate bulk session creation or attempt to exhaust the host.
