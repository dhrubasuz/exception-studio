# Demonstration guide

Prepared by **Dhruba Poudel** · **27 October 2026**

**[Open the public HTTPS demo](https://studio.dhrub.com.np/)** or run it locally using the [README instructions](../README.md). The hosted import, decisions, publication and actual downloads were verified on 27 October 2026. All examples below use fictional records and notes.

## A five-minute review

1. Open the application and load the mixed fictional sample. The initial reconciliation is **22 source rows = 16 accepted + 6 held + 0 excluded**.
2. Select the second occurrence of `DEMO-001` (source line 3). Change its reference to **`DEMO-002`**, add the reason **“Corrected the second fictional reference to its unique sequence value.”**, and choose **Save & accept row**.
3. Select the first `DEMO-001` (source line 2). Its duplicate issue has cleared, but it remains held for explicit review. Keep its values, add **“Reviewed the original fictional reference after its duplicate was corrected.”**, and accept it. No record was silently approved.
4. Resolve the remaining exceptions using the following demonstration decisions.

| Source row | Current problem | Demonstration decision and reason |
| --- | --- | --- |
| Line 6 · `DEMO-005` | Team is blank | Set team to `Service desk`. Reason: “Assigned this fictional item to the sample service desk team.” Accept. |
| Line 9 · `DEMO-008` | Due date is `2026-02-30` | Set due date to `2026-10-12`, after its opened date. Reason: “Replaced the impossible sample date with a valid date after opening.” Accept. |
| Line 12 · `DEMO-011` | Minutes are `-15` | Set minutes to `65`. Reason: “Corrected fictional effort to a non-negative whole number.” Accept. |
| Line 15 · `DEMO-014` | Status is `waiting` | Keep the values and choose **Exclude with reason**. Reason: “Excluded the unsupported fictional status to demonstrate an explained exclusion.” |

These are walkthrough corrections, not facts inferred from a real source system. A real review would require an authoritative source for the replacement values.

5. Confirm **22 = 21 accepted + 0 held + 1 excluded**. Accepted minutes should be **1405** for the decisions above. The excluded row remains visible and does not contribute to exported effort.
6. Open **Decision history**. Inspect the field changes, reasons and dataset revisions. The original values are still visible in the record inspector.
7. Choose **Freeze & publish**. Download the CSV and manifest. The CSV contains a header plus 21 accepted data rows; the manifest records 22 source rows and the explained exclusion.

## Prove an old publication stays frozen

1. Save the first CSV and JSON manifest locally. Note its `dataSha256` and revision.
2. In **Review queue**, switch to accepted records. Select any accepted record, increase its minutes by `5`, explain the fictional correction and accept it.
3. Confirm the current dataset revision increased. The old publication still references its original revision.
4. Download the earlier CSV again. Its bytes and hash should match the first download. Publishing the new revision creates a separate snapshot.

To calculate a saved file's hash in PowerShell:

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath '.\first-publication.csv'
```

Compare the hexadecimal value with `dataSha256` in the matching JSON manifest. Letter case does not affect that comparison. The automated persistence test also closes and reopens the same SQLite database before checking the frozen download.

## Demonstrate a stale editor

Use **two tabs in the same browser session** so they share one sandbox cookie. Two independent browsers normally receive different sandboxes and should not conflict with each other.

1. Load the same imported workspace in tabs A and B. Both show revision `r`.
2. Make a valid decision in A. It commits revision `r + 1`.
3. Without refreshing B, enter a different correction and reason there, then save.
4. B receives a revision conflict. Its unsaved form remains until you deliberately choose **Reload current revision**. No stale change is applied.

The technical section also provides a deliberate stale-request demonstration. It sends an earlier expected revision and should be rejected without changing the dataset.

## Inspect uncertain-request recovery

When a mutation's outcome cannot be confirmed, the interface pauses other changes and offers **Retry the same request**. It reuses the original key and body. Do not change that command to “make it work”: the server deliberately rejects a different body under an existing key.

An uncertain **New sandbox** response has a separate recovery path. Because the cookie may already have changed, the displayed workspace is marked stale and edits stay blocked until **Reload session** confirms the browser's current workspace. UI tests simulate these response-loss cases; reliably inducing them by disconnecting a real network depends on timing.

## A shorter tour

The technical section's **Load the clean fixture** action imports 22 valid fictional rows. It is useful for exploring publication without completing the review exercise. It creates a new active import; earlier sources and publications are retained until the sandbox expires. Do the mixed-fixture exercise first if you want to see exception handling.

## What to say when presenting it

> “I built this to make the step before reporting inspectable: preserve the source, reconcile every row, require explicit exception decisions, and freeze the reviewed output. The interesting cases are when another correction clears your issue, two editors save from the same revision, or the server commits but the response is lost. The API and interface handle those cases together.”

Describe the application as an original fictional-data portfolio project. Do not describe its demonstration records as employer data, its notes as verified approvals, its history as tamper-proof, or its controls as an enterprise security certification.

## Keep the boundaries visible

- Use fictional review notes only. Notes are transmitted to the server and stored with decisions.
- Access expires 24 hours after sandbox creation. Save wanted downloads before expiry; hosting redeployments may reset demo storage sooner.
- **New sandbox** changes this browser's cookie; it does not immediately erase the previous workspace. The previous workspace continues towards expiry.
- Separate browser sessions are isolated. Publication URLs require the owning cookie and are not public file-sharing links.
- A `429` means a demo quota was reached. Wait for its retry window rather than starting many new workspaces.
