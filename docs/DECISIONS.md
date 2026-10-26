# Engineering decisions

Author: **Dhruba Poudel** · Recorded: **27 October 2026**

These decisions explain the implemented trade-offs. They describe an anonymous fictional-data demonstration, with clear boundaries for any later production version.

## 01 · One review workflow before a larger platform

**Decision:** focus on import → exceptions → reasoned decisions → frozen export.

The project demonstrates business logic that can be inspected through a small interface and API. Authentication integrations, notifications, AI classification and connectors would add scope without improving the core proof. They are absent rather than represented by non-working controls.

**Consequence:** the system can show consistent behaviour across layers, but does not claim to be a complete enterprise data platform.

## 02 · Real persistence with a single Node process

**Decision:** use Node 24's built-in SQLite support with explicit SQL and bounded synchronous operations.

SQLite makes transactions, constraints, restart persistence and source/publication immutability inspectable without a paid service or a separate database installation. WAL and a busy timeout support the intended local-file runtime.

**Consequence:** this deployment model requires a writable persistent path and a single application instance. A multi-instance service would require a reviewed database/deployment design, migrations and operational monitoring. No such scale claim is made here.

## 03 · Preserve the source and separate the decision

**Decision:** store original CSV and row values separately from current corrections, review state and decision reasons.

Discarding a malformed row would obscure reconciliation. Replacing its original value would obscure the correction. SQL triggers reject updates to protected source columns and publication content; exclusions remain counted.

**Consequence:** storage includes repeated representations of a small bounded fixture. These controls protect application behaviour, while the database operator remains trusted. Event history is not cryptographically tamper-proof.

## 04 · A dataset revision protects cross-row rules

**Decision:** use one monotonically increasing revision per sandbox, covering imports and row decisions. Require it on decisions and publication.

A row-level version alone would not protect a batch-wide duplicate rule. Each decision or publication locks a write transaction and verifies the expected revision. Decisions revalidate the whole active import. Stale clients receive `409`; the UI keeps their unsaved edit until they explicitly reload saved state.

**Consequence:** unrelated concurrent edits can conflict. For a 200-row review workspace this is a deliberate simplicity trade-off. Publication references the current revision; it does not create a new dataset revision merely by downloading the same state.

## 05 · Rule clearance is not implicit approval

**Decision:** retain an original exception's unreviewed state until someone explicitly accepts or excludes it.

Correcting the second duplicate can remove the first row's current validation issue. The first row still needs a decision because the workflow distinguishes a rule result from review. Conversely, an accepted record that becomes invalid is held again.

**Consequence:** extra review actions are sometimes necessary. The queue explains why a row with no remaining issue can still be held.

## 06 · Retry the command that might have committed

**Decision:** require an idempotency key for import, decision and publication. Hash a canonical body, then store the exact successful snapshot under the sandbox/route/key combination in the same transaction.

A lost response is not evidence that the server rolled back. Matching retries return the stored response; changed content under the same key is a conflict. Failed validation rolls back key allocation too. Stored snapshots are gzip-compressed to bound the overhead of this explicit behaviour.

**Consequence:** retry responses can be older than current state. They confirm the original result; a separate read refreshes the workspace. Session creation is handled separately because cookie rotation can occur before the client reads the response: uncertain creation blocks editing until session reload succeeds.

## 07 · Freeze bytes, not a query

**Decision:** store the accepted CSV bytes and JSON manifest when publishing. Make the import/revision pair unique.

Regenerating a download from current rows would make an old link change meaning. Frozen bytes let reviewers compare SHA-256 values before and after later edits or a process restart. Spreadsheet formula prefixes are neutralised before calculating the exported-data hash.

**Consequence:** source and exported-data hashes intentionally differ when records change, rows are excluded or spreadsheet handling alters an exported cell. Hashes establish byte identity, not external approval or data truth.

## 08 · Public demo isolation without pretending to verify identity

**Decision:** use a random 32-byte opaque cookie token, store only its hash, scope database reads/writes to the sandbox and expire access after 24 hours.

HTTPS configuration uses a `__Host-` cookie with `Secure`, `HttpOnly`, `SameSite=Lax` and host-only scope. Same-origin checks protect mutation requests. The UI uses literal text for notes and API-provided publication paths are restricted to same-origin download routes.

**Consequence:** this is an access capability, not an authenticated organisational account or independently verified reviewer. It has no recovery, role hierarchy or cross-device identity. Anyone holding the cookie can use its sandbox.

## 09 · Fictional inputs and explicit retention

**Decision:** accept only bundled fixtures in both scope modes; bound requests, rows, sessions and stored operations; clean up expired sessions.

This avoids offering an unreviewed upload service through a public portfolio. Notes still reach SQLite, so visitors must use fictional text. Application expiry is enforced on access; physical cleanup follows on new-session creation or the periodic timer.

**Consequence:** cleanup is not secure erasure, and the operator's hosting logs/backups remain outside this application's deletion guarantee. Public demo storage may reset on deployment. A production system would need a separate privacy, retention, backup and recovery design.

## 10 · Test the failure modes that change trust

**Decision:** combine pure domain checks, persistent store checks, real HTTP checks and UI recovery checks.

The suite exercises rollback, concurrent stale writes, exact replay, immutable sources, frozen restart-safe downloads, session isolation and lost-response recovery. UI tests use a simulated DOM and do not certify visual quality or full accessibility. Browser and hosting verification remain separate release checks.

**Consequence:** passing tests provide evidence for the cases asserted. They are not a security audit, universal correctness proof or a numerical quality rating.
