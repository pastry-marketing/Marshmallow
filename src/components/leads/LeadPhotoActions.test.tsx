import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import LeadPhotoActions from "./LeadPhotoActions";

const mocks = vi.hoisted(() => ({
  auth: { role: "admin", canAccess: (_key: string): boolean => true },
  copy: vi.fn(), sign: vi.fn(), resolveChat: vi.fn(), prepare: vi.fn(),
}));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => mocks.auth }));
vi.mock("@/lib/lead-copy", () => ({ copyImagesToClipboard: mocks.copy }));
vi.mock("@/lib/storage", () => ({ getSignedUrls: mocks.sign }));
vi.mock("@/lib/quo-tech-photos", () => ({ resolveTechPhotoChat: mocks.resolveChat, prepareTechPhotos: mocks.prepare }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); mocks.auth.role = "admin"; mocks.auth.canAccess = () => true; });

describe("lead photo action permissions", () => {
  it("hides technician handoff for CS Admin even if Tech Quick Chat is granted", () => {
    mocks.auth.role = "cs_admin";
    render(<LeadPhotoActions paths={["one", "two"]} techNumber="4155550123" />);
    expect(screen.getByRole("button", { name: "Copy all 2 photos" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send photos to tech" })).not.toBeInTheDocument();
  });

  it("requires Tech Quick Chat permission for the technician action", () => {
    mocks.auth.canAccess = () => false;
    render(<LeadPhotoActions paths={["one"]} techNumber="4155550123" />);
    expect(screen.queryByRole("button", { name: "Send photos to tech" })).not.toBeInTheDocument();
  });

  it("hands all signed originals to the saved technician chat", async () => {
    mocks.resolveChat.mockResolvedValue("https://my.quo.com/inbox/tech/c/assigned");
    mocks.sign.mockResolvedValue(["signed-one", "signed-two"]);
    mocks.prepare.mockResolvedValue(undefined);
    render(<LeadPhotoActions paths={["one", "two"]} techNumber="4155550123" />);
    fireEvent.click(screen.getByRole("button", { name: "Send photos to tech" }));
    await waitFor(() => expect(mocks.prepare).toHaveBeenCalledWith("https://my.quo.com/inbox/tech/c/assigned", ["signed-one", "signed-two"]));
    expect(mocks.resolveChat).toHaveBeenCalledWith("4155550123");
  });
});
