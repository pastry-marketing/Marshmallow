import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { TechnicianRecord } from "./TechnicianDialog";
import { TechnicianProcessingWorkflow } from "./TechnicianProcessingWorkflow";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { functions: { invoke } } }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ role: "admin", user: null, canAccess: () => true }) }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock("@/lib/activity", () => ({ logActivity: vi.fn() }));
vi.mock("@/lib/tech-change-requests", () => ({ requestTechnicianChange: vi.fn() }));
vi.mock("@/components/leads/QuoPhoneTrigger", () => ({ default: () => null }));
vi.mock("./TechnicianNameCell", () => ({ TechnicianNameBadges: () => null }));

const technicians = [
  { id: "t1", name: "Adam", phone_number: "6302596403", is_active: true },
  { id: "t2", name: "Brandon", phone_number: "9513904040", is_active: true },
] as TechnicianRecord[];
const result = (id: string, labels: string[] = []) => ({
  technicianId: id, labels, recommendations: [], summary: "Reviewed chat.", evidence: [],
  conversationsReviewed: 1, messagesReviewed: 15, jobCounts: { completed: 0, paid: 0, error: null }, error: null,
});

describe("workflow review recovery", () => {
  beforeEach(() => {
    vi.stubGlobal("AbortSignal", { timeout: () => new AbortController().signal });
    invoke.mockReset();
    invoke.mockImplementation((_name, { body }) => Promise.resolve({ data: body.action === "load"
      ? { assessments: [], reports: [] }
      : body.action === "health" ? { aiConfigured: true, directQuoConfigured: true }
      : body.action === "save_labels" ? { success: true }
      : { results: body.technicianIds.map((id: string) => result(id)) }, error: null }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("publishes a successful review while another technician fails", async () => {
    invoke.mockImplementation((_name, { body }) => Promise.resolve({ data: body.action === "load" ? { assessments: [], reports: [] }
      : body.action === "health" ? { aiConfigured: true, directQuoConfigured: false }
      : { results: [body.technicianIds[0] === "t1" ? result("t1") : { ...result("t2"), error: "Quo denied access" }] }, error: null }));
    render(<MemoryRouter><TechnicianProcessingWorkflow technicians={technicians} initialTechnicianIds={["t1", "t2"]} /></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole("button", { name: "Quick Report (2)" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Quick Report (2)" }));
    await waitFor(() => expect(screen.getByText(/Error: Quo denied access/)).toBeInTheDocument());
    expect(within(screen.getByRole("heading", { name: "Adam" }).closest("article")!).getByText("Reviewed chat.")).toBeInTheDocument();
    expect(screen.getByText(/Direct Quo history is not configured/)).toBeInTheDocument();
  });

  it("retries one technician without discarding another report or manual label choices", async () => {
    render(<MemoryRouter><TechnicianProcessingWorkflow technicians={technicians} initialTechnicianIds={["t1", "t2"]} /></MemoryRouter>);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("technician-chat-assessment", { body: { action: "load", technicianIds: ["t1", "t2"] } }));
    fireEvent.click(screen.getByRole("button", { name: "Quick Report (2)" }));
    await screen.findAllByText("Reviewed chat.");
    const adam = within(screen.getByRole("heading", { name: "Adam" }).closest("article")!);
    fireEvent.click(adam.getByRole("button", { name: "Late payment" }));
    invoke.mockImplementation((_name, { body }) => Promise.resolve({ data: body.action === "save_labels"
      ? { success: true }
      : { results: [result("t1", ["good_tech"])] }, error: null }));
    fireEvent.click(adam.getByRole("button", { name: "Retry review" }));
    await waitFor(() => expect(adam.getByText("Evidence-backed suggestions")).toBeInTheDocument());
    expect(invoke).toHaveBeenLastCalledWith("technician-chat-assessment", expect.objectContaining({ body: { action: "assess", technicianIds: ["t1"] } }));
    expect(adam.getByRole("button", { name: "Late payment" })).toHaveAttribute("aria-pressed", "true");
    expect(adam.getByRole("button", { name: /^Good Tech$/ })).toHaveAttribute("aria-pressed", "false");
    const brandon = within(screen.getByRole("heading", { name: "Brandon" }).closest("article")!);
    expect(brandon.getByText("Reviewed chat.")).toBeInTheDocument();
    fireEvent.click(adam.getByRole("button", { name: "Save labels" }));
    await waitFor(() => expect(invoke).toHaveBeenLastCalledWith("technician-chat-assessment", { body: { action: "save_labels", technicianId: "t1", labels: ["late_payment"] } }));
  });
});
