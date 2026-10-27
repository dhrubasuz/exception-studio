# Five-minute Team Edition walkthrough

Prepared by **Dhruba Poudel** · Fictional data only

Open [Exception Studio](https://studio.dhrub.com.np/), create a workspace and save the one-time account kit if needed after reload. The same visitor controls both fictional accounts; their separation demonstrates permissions.

## 1. Repair schema drift

Sign in as Avery, the analyst. Queue schema drift. The source arrives with the wrong shape and stops. Inspect original JSON/hash. Enter a valid uppercase reference, fictional team and whole minutes, give a repair reason, then submit for approval.

Switch to Sam, the approver. Inspect proposed values and the analyst reason. Approve with a separate reason. The worker writes a receipt. Inspect actor history and download the trace. The invalid original source remains separate from the delivered payload.

## 2. Prove recovery after an uncertain outcome

Queue **lost delivery response** as Avery. Review/submit, then approve as Sam. First delivery records a timeout even though its receipt is committed. The scheduled retry becomes delivered with two delivery attempts and one receipt. This tests the sandbox destination's event deduplication contract.

## 3. Recover an outage

Queue upstream outage as Avery. Three 503 responses lead to dead letter. Explicitly restore/replay with a reason, then review and approve normally. The trace retains earlier failures and the new generation.

## 4. Inspect the boundaries

- Approvers cannot perform analyst commands; the API enforces this too.
- Changed revisions reject stale decisions.
- Repeating the duplicate-event scenario retains one source-event job.
- Reload restores the current account and persisted jobs, but not unsaved credentials/drafts.
- `/classic` retains the import/reconciliation/export workbench.

No business savings are claimed from fictional records or simulated failures.
