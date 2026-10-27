# Team Edition architecture

Author and maintainer: **Dhruba Poudel** · 28 October 2026

```text
React interface ── same-origin JSON ── Node HTTP API ── SQLite transactions
                                          │                   │
                                    account + role         durable jobs
                                    revision + key         leases/events
                                                              │
                                                      background worker
                                                              │
                                                   authenticated loopback HTTP
                                                              │
                                          fixed source + destination sandbox
                                                     receipt deduplication
```

## Account and command boundary

Workspace creation provisions two fictional accounts with random passwords; the server stores salted scrypt hashes. Sign-in issues an opaque session cookie. The API rejects unknown fields, checks ownership and requires the correct server-side role.

Enqueue, review, approve and replay require `Idempotency-Key`. The key binds actor, route and canonical body. Repeating it returns a current workspace snapshot without repeating the action; it does not replay historical response bytes. Altered reuse returns `409`. Invalid/stale commands roll back without consuming a successful-command record.

Human decisions also include `expectedRevision`, checked inside the transaction that changes state and writes evidence. Polling does not authorise a decision.

## Job state and recovery

```text
queued_source → running_source → awaiting_review → awaiting_approval
                      │               ↑                    │
                      ├→ schema_error ┘             queued_delivery
                      └→ retry_source                    │
                             │                     running_delivery
                       dead_letter                       │
                             │                    retry_delivery → delivered
                    explicit analyst replay              │
                             └→ queued_source       dead_letter
```

The worker claims one eligible job in a short transaction, records a lease and increments its attempt count. HTTP runs after commit. Completion needs that lease token; a late old response cannot overwrite a newer claim. Expired leases become retryable or dead-lettered at the bound. Each phase allows three attempts per generation. Source replay allows three generations, requires a reason and an explicit choice whether to restore the outage fixture.

Bounded exponential retries respect the sandbox's `Retry-After`. Schema errors require analyst correction. Source success never skips review. Analyst submission records a validated payload; a distinct approver account authorises delivery.

## Side effects and uncertainty

Actual loopback HTTP source/destination routes require a process-generated secret. No arbitrary connector URLs are accepted. Original source snapshots/hash remain separate from corrections.

A stable source event ID and unique workspace/event receipt make destination writes idempotent. The lost-response fixture commits then delays its reply past the deadline. Retrying the same event/payload returns the existing receipt. This is at-least-once attempt handling with deduplicated sandbox effects, not a universal exactly-once guarantee.

## Evidence and limits

Attempts retain phase, number/generation, duration, outcome, HTTP status and trace/span IDs. HTTP durations are measured; an interrupted lease recovered after restart records the configured lease duration as an estimate. Events retain actor/reason; receipts retain a payload hash. Trace downloads include the job, attempts and related events. p95 uses nearest rank over recorded durations, including failures and lease estimates; it is not browser response time or business savings.

SQLite WAL, one Node process and bounded fictional workspaces make the lab reproducible. There is no distributed broker, external connector, verified organisational identity, OpenTelemetry installation or backup service. See [security scope](../SECURITY.md).
