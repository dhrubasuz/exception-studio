// Author, creator and maintainer: Dhruba Poudel.
import { describe, expect, it } from "vitest";
import type { OperationalRecord, RowView } from "../shared/contracts.js";
import {
  changedValues,
  downloadPath,
  filterRows,
  held,
  summaryWidths,
} from "./view";

const original: OperationalRecord = {
  reference: "ORIGINAL-001",
  team: "Support",
  opened: "2026-10-01",
  due: "2026-10-02",
  status: "open",
  minutes: "20",
};
function row(id: string, changes: Partial<RowView> = {}): RowView {
  return {
    id,
    lineNumber: 2,
    original: { ...original },
    current: { ...original },
    decision: "accepted",
    issues: [],
    changedFields: [],
    lastReason: null,
    reviewed: false,
    ...changes,
  };
}

describe("review presentation rules", () => {
  it("keeps an original exception held until a person confirms it, even with no current validation issues", () => {
    expect(held(row("unreviewed", { decision: "unreviewed" }))).toBe(true);
    expect(held(row("accepted"))).toBe(false);
    expect(held(row("excluded", { decision: "excluded" }))).toBe(false);
  });
  it("searches both source references and corrected values within the selected decision scope", () => {
    const corrected = row("corrected", {
      current: { ...original, reference: "CORRECTED-002" },
    });
    const pending = row("pending", { decision: "unreviewed" });
    expect(
      filterRows([corrected, pending], "accepted", "original-001").map(
        (item) => item.id,
      ),
    ).toEqual(["corrected"]);
    expect(
      filterRows([corrected, pending], "all", "corrected-002").map(
        (item) => item.id,
      ),
    ).toEqual(["corrected"]);
    expect(
      filterRows([corrected, pending], "held", "").map((item) => item.id),
    ).toEqual(["pending"]);
  });
  it("submits only changed values and leaves the original record untouched", () => {
    const before = { ...original };
    expect(changedValues(original, { ...original, minutes: "35" })).toEqual({
      minutes: "35",
    });
    expect(original).toEqual(before);
  });
  it("keeps an empty reconciliation finite and reconciles accepted, held and excluded widths", () => {
    expect(
      summaryWidths({
        total: 0,
        accepted: 0,
        held: 0,
        excluded: 0,
        changed: 0,
        acceptedMinutes: 0,
      }),
    ).toEqual([0, 0, 0]);
    expect(
      summaryWidths({
        total: 20,
        accepted: 12,
        held: 5,
        excluded: 3,
        changed: 0,
        acceptedMinutes: 0,
      }),
    ).toEqual([60, 25, 15]);
  });
  it("limits download links to the own-origin publication endpoints", () => {
    expect(downloadPath("/api/publications/pub_123-456.csv")).toBe(
      "/api/publications/pub_123-456.csv",
    );
    expect(downloadPath("https://other.example/export.csv")).toBeUndefined();
    expect(downloadPath("javascript:alert(1)")).toBeUndefined();
    expect(downloadPath("/api/publications/../../secret.csv")).toBeUndefined();
  });
});
