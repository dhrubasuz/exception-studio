// Author, creator and maintainer: Dhruba Poudel.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type {
  OperationalRecord,
  RowView,
  WorkspaceSnapshot,
} from "../shared/contracts.js";
import { App } from "./App";

const SOURCE: OperationalRecord = {
  reference: "DEMO-002",
  team: "",
  opened: "2026-10-01",
  due: "2026-10-08",
  status: "open",
  minutes: "30",
};

function row(overrides: Partial<RowView> = {}): RowView {
  return {
    id: "row-2",
    lineNumber: 3,
    original: { ...SOURCE },
    current: { ...SOURCE },
    decision: "unreviewed",
    issues: [{ field: "team", code: "REQUIRED", message: "Team is required." }],
    changedFields: [],
    lastReason: null,
    reviewed: false,
    ...overrides,
  };
}

function workspace(
  imported = true,
  overrides: Partial<WorkspaceSnapshot> = {},
): WorkspaceSnapshot {
  return {
    session: {
      id: "fictional-test-session",
      createdAt: "2026-10-26T00:00:00.000Z",
      expiresAt: "2026-10-27T00:00:00.000Z",
    },
    mode: "fictional-demo",
    revision: imported ? 1 : 0,
    activeImport: imported
      ? {
          id: "import-1",
          name: "Fictional service records",
          fixtureId: "mixed",
          createdAt: "2026-10-26T00:00:00.000Z",
          sourceSha256: "1".repeat(64),
          sourceRows: 1,
        }
      : null,
    rows: imported ? [row()] : [],
    summary: {
      total: imported ? 1 : 0,
      accepted: 0,
      held: imported ? 1 : 0,
      excluded: 0,
      changed: 0,
      acceptedMinutes: 0,
    },
    events: [],
    publications: [],
    limits: {
      maxRows: 200,
      requestBytes: 65536,
      lifetimeHours: 24,
      maxPublications: 20,
      maxImports: 20,
    },
    ...overrides,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const fetchMock = vi.fn<typeof fetch>();
const dialogMethods = ["showModal", "close"] as const;
const originalDialogMethods = dialogMethods.map((method) =>
  Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, method),
);
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  // jsdom has dialog elements but does not implement the native modal methods.
  for (const method of dialogMethods) {
    Object.defineProperty(HTMLDialogElement.prototype, method, {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.open = method === "showModal";
      },
    });
  }
});
afterEach(() => {
  cleanup();
  dialogMethods.forEach((method, index) => {
    const original = originalDialogMethods[index];
    if (original)
      Object.defineProperty(HTMLDialogElement.prototype, method, original);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, method);
  });
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe("a real-API review workflow", () => {
  it("shows a connection failure instead of replacing the backend with mock records", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Network unavailable"));
    render(<App />);
    await screen.findByText("The workspace could not be opened.");
    expect(
      screen.queryByRole("button", { name: /Open the fictional import/ }),
    ).toBeNull();
    expect(screen.queryByText("The review queue")).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/session",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("retries an uncertain mutation using exactly its original idempotency key and body", async () => {
    fetchMock
      .mockResolvedValueOnce(json(workspace(false)))
      .mockRejectedValueOnce(new TypeError("Connection lost after send"))
      .mockResolvedValueOnce(json(workspace()));
    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: /Open the fictional import/ }),
    );
    await screen.findByText("The result is not yet confirmed.");
    const originalCall = fetchMock.mock.calls[1];
    expect(originalCall?.[0]).toBe("/api/imports");
    const originalHeaders = new Headers(originalCall?.[1]?.headers);
    const originalKey = originalHeaders.get("Idempotency-Key");
    expect(originalKey).toMatch(/^[a-f0-9-]{36}$/i);
    fireEvent.click(
      screen.getByRole("button", { name: "Retry the same request" }),
    );
    await screen.findByText("The review queue");
    const retriedCall = fetchMock.mock.calls[2];
    expect(retriedCall?.[0]).toBe(originalCall?.[0]);
    expect(retriedCall?.[1]?.body).toBe(originalCall?.[1]?.body);
    expect(new Headers(retriedCall?.[1]?.headers).get("Idempotency-Key")).toBe(
      originalKey,
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("blocks old-session changes after an unreadable cookie-rotation response until the active session is reloaded", async () => {
    let browserSession = workspace();
    const rotatedSession = workspace(false, {
      session: {
        id: "rotated-session",
        createdAt: "2026-10-26T01:00:00.000Z",
        expiresAt: "2026-10-27T01:00:00.000Z",
      },
    });
    fetchMock
      .mockImplementationOnce(async () => json(browserSession))
      .mockImplementationOnce(async () => {
        // The browser applies Set-Cookie before the response body can be read.
        browserSession = rotatedSession;
        return new Response("Incomplete response body", { status: 200 });
      })
      .mockRejectedValueOnce(new TypeError("Session reload unavailable"))
      .mockImplementationOnce(async () => json(browserSession))
      .mockImplementationOnce(async () =>
        json(workspace(true, { session: browserSession.session })),
      );
    render(<App />);
    await screen.findByText("The review queue");
    fireEvent.change(
      screen.getByRole("textbox", { name: "Reason for this decision" }),
      { target: { value: "A review note for the old session." } },
    );
    fireEvent.click(screen.getByRole("button", { name: "New sandbox" }));
    fireEvent.click(await screen.findByRole("button", { name: "Start fresh" }));
    await screen.findByText("A fresh sandbox was not confirmed.");
    expect(browserSession.session.id).toBe("rotated-session");
    expect(
      (screen.getByRole("textbox", { name: "Reference" }) as HTMLInputElement)
        .value,
    ).toBe("DEMO-002");
    expect(
      screen.getByText("Session unconfirmed · displayed records are stale"),
    ).toBeTruthy();
    for (const name of [
      "New sandbox",
      "Save & accept row",
      "Exclude with reason",
      "Refresh saved revision",
    ]) {
      const button = screen.getByRole("button", { name: new RegExp(name) });
      expect(button.matches(":disabled")).toBe(true);
      fireEvent.click(button);
    }
    for (const text of [
      "Demonstrate a stale request",
      "Load the clean fixture",
    ]) {
      const button = screen.getByText(text).closest("button");
      expect(button?.disabled).toBe(true);
      if (button) fireEvent.click(button);
    }
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Retry the same request" }),
    ).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "Reload session" }));
    await screen.findByText("The current session is still unconfirmed.");
    expect(
      screen
        .getByRole("button", { name: "Exclude with reason" })
        .matches(":disabled"),
    ).toBe(true);
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
    expect(fetchMock.mock.calls[2]?.[0]).toBe("/api/session");
    expect(fetchMock.mock.calls[2]?.[1]?.method).toBe("GET");

    fireEvent.click(screen.getByRole("button", { name: "Reload session" }));
    await screen.findByText("The current session is confirmed.");
    expect(fetchMock.mock.calls[3]?.[0]).toBe("/api/session");
    expect(fetchMock.mock.calls[3]?.[1]?.method).toBe("GET");
    expect(screen.queryByText("The review queue")).toBeNull();
    const importButton = screen.getByRole("button", {
      name: /Open the fictional import/,
    });
    expect((importButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(importButton);
    await screen.findByText("The review queue");
    expect(fetchMock.mock.calls[4]?.[0]).toBe("/api/imports");
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("preserves an unsaved correction after 409, then reloads server values only on explicit recovery", async () => {
    const newer = workspace(true, {
      revision: 9,
      rows: [row({ current: { ...SOURCE, reference: "SERVER-009" } })],
    });
    fetchMock
      .mockResolvedValueOnce(json(workspace()))
      .mockResolvedValueOnce(
        json(
          {
            error: {
              code: "REVISION_CONFLICT",
              message: "Another decision changed this dataset.",
              currentRevision: 9,
            },
          },
          409,
        ),
      )
      .mockResolvedValueOnce(json(newer));
    render(<App />);
    await screen.findByText("The review queue");
    const reference = screen.getByRole("textbox", {
      name: "Reference",
    }) as HTMLInputElement;
    const reason = screen.getByRole("textbox", {
      name: "Reason for this decision",
    }) as HTMLTextAreaElement;
    fireEvent.change(reference, { target: { value: "MY-DRAFT-001" } });
    fireEvent.change(reason, {
      target: { value: "Correcting the fictional import reference." },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save & accept row/ }));
    await screen.findByText("Another decision changed this dataset.");
    expect(reference.value).toBe("MY-DRAFT-001");
    expect(reason.value).toBe("Correcting the fictional import reference.");
    expect(
      JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)).expectedRevision,
    ).toBe(1);
    fireEvent.click(
      screen.getByRole("button", { name: "Reload current revision" }),
    );
    await screen.findByText("Current server revision loaded.");
    expect(
      (screen.getByRole("textbox", { name: "Reference" }) as HTMLInputElement)
        .value,
    ).toBe("SERVER-009");
    expect(
      (
        screen.getByRole("textbox", {
          name: "Reason for this decision",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("");
    expect(fetchMock.mock.calls[2]?.[0]).toBe("/api/workspace");
  });

  it("blocks publication while a held row remains, even when its current validation issues are clear", async () => {
    fetchMock.mockResolvedValueOnce(
      json(workspace(true, { rows: [row({ issues: [] })] })),
    );
    render(<App />);
    await screen.findByText("The review queue");
    const publish = screen.getByRole("button", {
      name: /Freeze & publish/,
    }) as HTMLButtonElement;
    expect(publish.disabled).toBe(true);
    fireEvent.click(publish);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText(
        "An original exception still needs an explicit review decision.",
      ),
    ).toBeTruthy();
  });

  it("requires a human review reason before sending a row decision", async () => {
    fetchMock.mockResolvedValueOnce(json(workspace()));
    render(<App />);
    await screen.findByText("The review queue");
    fireEvent.click(
      screen.getByRole("button", { name: "Exclude with reason" }),
    );
    expect(
      screen.getByText("Give a specific reason of at least 10 characters."),
    ).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(
      screen.getByRole("textbox", { name: "Reason for this decision" }),
    );
  });

  it("publishes the displayed revision and exposes the frozen CSV and manifest from the server", async () => {
    const clean = workspace(true, {
      revision: 7,
      rows: [
        row({
          current: { ...SOURCE, team: "Web" },
          decision: "accepted",
          issues: [],
          reviewed: true,
        }),
      ],
      summary: {
        total: 1,
        accepted: 1,
        held: 0,
        excluded: 0,
        changed: 1,
        acceptedMinutes: 30,
      },
    });
    const published = workspace(true, {
      ...clean,
      publications: [
        {
          id: "publication-1",
          revision: 7,
          createdAt: "2026-10-26T01:00:00.000Z",
          dataSha256: "a".repeat(64),
          acceptedRows: 1,
          excludedRows: 0,
          csvUrl: "/api/publications/publication-1.csv",
          manifestUrl: "/api/publications/publication-1.json",
        },
      ],
    });
    fetchMock
      .mockResolvedValueOnce(json(clean))
      .mockResolvedValueOnce(json(published));
    render(<App />);
    await screen.findByText("The review queue");
    fireEvent.click(screen.getByRole("button", { name: /Freeze & publish/ }));
    const csv = await screen.findByRole("link", { name: /Download CSV/ });
    const manifest = screen.getByRole("link", { name: /Manifest JSON/ });
    expect(csv.getAttribute("href")).toBe(
      "/api/publications/publication-1.csv",
    );
    expect(manifest.getAttribute("href")).toBe(
      "/api/publications/publication-1.json",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      expectedRevision: 7,
    });
    expect(
      screen
        .getByRole("button", { name: /Frozen exports/ })
        .getAttribute("aria-current"),
    ).toBe("page");
  });

  it("renders literal review notes as text and never as active HTML", async () => {
    const note = "<img src=x onerror=alert(1)>";
    fetchMock.mockResolvedValueOnce(
      json(
        workspace(true, {
          events: [
            {
              id: 1,
              type: "row.excluded",
              createdAt: "2026-10-26T01:00:00.000Z",
              revision: 2,
              message: "A fictional row was excluded.",
              rowId: "row-2",
              reason: note,
              changes: null,
            },
          ],
        }),
      ),
    );
    render(<App />);
    await screen.findByText("The review queue");
    fireEvent.click(screen.getByRole("button", { name: /Decision history/ }));
    await waitFor(() => expect(screen.getByText(`“${note}”`)).toBeTruthy());
    expect(document.querySelector("img")).toBeNull();
  });
});
