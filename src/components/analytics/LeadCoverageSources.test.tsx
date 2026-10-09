import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoverageAnalyticsLead } from "@/lib/lead-coverage-analytics";
import { LeadCoverageSources } from "./LeadCoverageSources";

const mocks = vi.hoisted(() => ({ role: "admin", from: vi.fn() }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ role: mocks.role, user: { id: "user-1" } }) }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: mocks.from } }));
vi.mock("recharts", () => ({
  Bar: () => null, BarChart: () => null, CartesianGrid: () => null, Legend: () => null,
  ResponsiveContainer: () => null, Tooltip: () => null, XAxis: () => null, YAxis: () => null,
}));

function installRows(rows: CoverageAnalyticsLead[]) {
  mocks.from.mockImplementation(() => {
    let from = 0;
    let to = 999;
    const query = {
      select: vi.fn(() => query), gte: vi.fn(() => query), lte: vi.fn(() => query), order: vi.fn(() => query),
      range: vi.fn((start: number, end: number) => { from = start; to = end; return query; }),
      abortSignal: vi.fn(() => Promise.resolve({ data: rows.slice(from, to + 1), error: null })),
    };
    return query;
  });
}
const row = (id: string, overrides: Partial<CoverageAnalyticsLead> = {}): CoverageAnalyticsLead => ({
  id, created_at: "2026-10-09T12:00:00Z", coverage_level: "good", coverage_area_label: "Dallas, TX", city: "Dallas", state: "TX", number_name: "Line A", ...overrides,
});
function renderReport(rangeError?: string) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><LeadCoverageSources startMs={Date.parse("2026-10-01")} endMs={Date.parse("2026-10-10")} rangeError={rangeError} /></QueryClientProvider>);
}

describe("Admin lead coverage report", () => {
  beforeEach(() => { mocks.role = "admin"; mocks.from.mockReset(); });

  it("does not query or render the report for a non-Admin", () => {
    mocks.role = "processor";
    renderReport();
    expect(screen.queryByRole("region", { name: "Lead Coverage & Sources report" })).not.toBeInTheDocument();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("rejects invalid custom ranges before making a request", () => {
    renderReport("Start date must be on or before the end date.");
    expect(screen.getByRole("alert")).toHaveTextContent("Start date must be on or before the end date.");
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("counts beyond PostgREST's 1000-row cap and keeps unknown coverage out of bad coverage", async () => {
    installRows([...Array.from({ length: 1000 }, (_, i) => row(String(i))), row("extra", { coverage_level: null, number_name: "Line B" })]);
    renderReport();
    const region = await screen.findByRole("region", { name: "Lead Coverage & Sources report" });
    await waitFor(() => expect(within(region).getByText("Total incoming jobs").parentElement).toHaveTextContent((1001).toLocaleString()));
    expect(mocks.from).toHaveBeenCalledTimes(2);
    expect(within(region).getByText("Unknown Coverage").parentElement).toHaveTextContent("1");
    expect(within(region).getByText("Bad Coverage").parentElement).toHaveTextContent("0");
    const query = mocks.from.mock.results[0].value;
    expect(query.gte).toHaveBeenCalledWith("created_at", "2026-10-01T00:00:00.000Z");
    expect(query.lte).toHaveBeenCalledWith("created_at", "2026-10-10T00:00:00.000Z");
  });

  it("filters all report totals when a source row is selected and resets on demand", async () => {
    installRows([row("1"), row("2", { coverage_level: "bad", number_name: "Line B" })]);
    renderReport();
    const region = await screen.findByRole("region", { name: "Lead Coverage & Sources report" });
    fireEvent.click(within(region).getByRole("button", { name: "Line B" }));
    expect(within(region).getByText("Total incoming jobs").parentElement).toHaveTextContent("1");
    expect(within(region).getByText("Good Coverage").parentElement).toHaveTextContent("0");
    fireEvent.click(within(region).getByRole("button", { name: "Reset filters" }));
    expect(within(region).getByText("Total incoming jobs").parentElement).toHaveTextContent("2");
  });
});
