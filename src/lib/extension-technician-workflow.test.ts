import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const source = readFileSync("tmp_extension/quo-crm-extension/technician-workflow.js", "utf8");
const html = '<div id="lead-capture-container"><details id="technician-intelligence" hidden><button id="technician-find">Find</button><select id="technician-picker"></select><button id="technician-review" disabled>Review</button><button id="technician-save-labels" hidden>Save</button><p id="technician-feedback"></p><div id="technician-report"></div><a id="technician-open-workflow"></a></details></div>';
afterEach(() => document.body.replaceChildren());

function start(role: string) {
  document.body.innerHTML = html;
  const sendMessage = vi.fn(async (message) => {
    if (message.type === "CHECK_AUTH") return { success: true, role };
    if (message.type === "GET_SETTINGS") return { settings: { apiBaseUrl: "https://crm.example" } };
    if (message.type === "GET_DRAFT") return { draft: { customerNumber: "4155550123" } };
    const action = message.payload.action;
    if (action === "resolve_technician") return { success: true, technicians: [{ id: "tech-1", name: "Alice", phone_number: "4155550123" }] };
    if (action === "load") return { success: true, assessments: [{ labels: [] }] };
    if (action === "assess") return { success: true, results: [{ technicianId: "tech-1", labels: ["good_tech"], summary: "Evidence verified", jobCounts: { completed: 5, paid: 3 }, messagesReviewed: 20, evidence: [], chatSource: "CRM mirror" }] };
    return { success: true };
  });
  runInNewContext(source, { document, chrome: { runtime: { sendMessage } }, MutationObserver,
    window: { addEventListener: vi.fn() }, encodeURIComponent });
  return sendMessage;
}

describe("native Donut technician review", () => {
  it("uses the same assessment and reviewed-label actions without changing flags", async () => {
    const send = start("processor");
    await waitFor(() => expect(document.getElementById("technician-intelligence")?.hidden).toBe(false));
    fireEvent.click(document.getElementById("technician-find")!);
    await waitFor(() => expect(document.getElementById("technician-review")).not.toBeDisabled());
    fireEvent.click(document.getElementById("technician-review")!);
    await waitFor(() => expect(document.getElementById("technician-report")?.textContent).toContain("Evidence verified"));
    const checkbox = document.querySelector<HTMLInputElement>('input[value="good_tech"]')!;
    expect(checkbox.checked).toBe(false); // AI advice is not a saved human decision.
    fireEvent.click(checkbox);
    fireEvent.click(document.getElementById("technician-save-labels")!);
    await waitFor(() => expect(send).toHaveBeenCalledWith({ type: "TECHNICIAN_WORKFLOW", payload: { action: "save_labels", technicianId: "tech-1", labels: ["good_tech"] } }));
    expect(document.getElementById("technician-open-workflow")?.getAttribute("href")).toBe("https://crm.example/technicians?workflow=tech-1");
  });

  it("keeps Technician Intelligence hidden from customer service", async () => {
    start("customer_service");
    await Promise.resolve();
    expect(document.getElementById("technician-intelligence")?.hidden).toBe(true);
  });
});
