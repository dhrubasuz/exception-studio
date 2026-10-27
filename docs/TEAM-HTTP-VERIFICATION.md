# Team edition: HTTP verification

Author and maintainer: **Dhruba Poudel**  
Verified locally: **28 October 2026**

The dedicated team HTTP suite exercises the running Node server, SQLite-backed
team store and connector worker together. It sends real HTTP requests to the
fictional loopback source and destination; it does not replace `fetch` with a
successful stub.

```sh
pnpm build:server
node --test tests/team-http.test.mjs
```

Result for this check: **15 passed; 0 failed; 0 skipped**. The classic edition and
store-level suites run separately and remain part of the complete test command.

## Boundaries checked

| Check | Observed result |
| --- | --- |
| Account authentication | No actor session returns `401`; incorrect passwords are denied; snapshots omit the issued passwords and database hashes. |
| Server roles | An approver cannot enqueue or submit a review. An analyst cannot approve, including when a request forges a role header. |
| Independent actor workflow | Analyst review followed by a different approver reaches a verified destination receipt and one destination write. |
| Request origin and input | Missing, null and foreign origins are denied. An arbitrary connector URL, invalid JSON and the wrong content type are rejected. |
| Session cookies | A configured HTTPS public origin produces a Secure, HttpOnly, host-scoped cookie. Logging out revokes the old token. |
| Exact command retries | Reusing the same key and body replays the original command. Reusing a key with different input returns `409` and creates no extra job. |
| Concurrent human reviews | Two decisions using the same expected revision produce one commit and one `409`, with one submitted-review event. |
| Workspace isolation | A valid account in another workspace cannot retrieve the job trace or approve the job; both attempts return `404`. |
| Mutation rate limit | Rotating forged Classic and Team cookie values does not evade the same-peer mutation bound; reads remain available. |
| Connector boundary | Missing and incorrect private sandbox headers are denied before destination writes. |
| Actual HTTP `429` | Both early source attempts return `429`; their status and outcome are recorded. `Retry-After` prevents another claim at 999 ms and permits it at 1,000 ms. The third source attempt recovers. |
| Competing workers | Two workers racing for one queued source job create one claim and one source attempt. |
| Source response timeout | The first real source request exceeds the 500 ms deadline. A due retry retains the event ID and records a successful second attempt. |
| Lost destination response | The destination commits a receipt before its first response exceeds the deadline. The retry confirms the same event with **one total destination write**. |
| Schema drift | Changed source fields hold the job for explicit repair. Review preserves the original source JSON and SHA-256. |
| Bounded failure and replay | Three failed upstream attempts reach the failed queue. An explicit restoration starts a new generation while retaining earlier attempts. |

## Interpretation

The retry tests advance an injected store clock to check eligibility without
sleeping through backoff. HTTP calls, 429 responses and delayed source/destination
responses are real. The Secure-cookie check inspects server behaviour for a
configured HTTPS origin; it is not a live TLS or hosting test.

The accounts and records are fictional. One visitor can operate both demo
accounts, so this demonstrates server-enforced account roles and separate actor
IDs rather than verified independent human identities. The connector worker is
restricted to this application's loopback sandbox; these tests do not establish
compatibility with external business APIs or production identity providers.

An independent implementation review covered the scoped SQL lookups,
transactional command records, immutable-source trigger, persisted lease tokens
and receipt uniqueness constraints. No critical issue was identified in those
reviewed paths during this check. This is a bounded engineering review, not an
external security audit or a guarantee that every defect has been found.
