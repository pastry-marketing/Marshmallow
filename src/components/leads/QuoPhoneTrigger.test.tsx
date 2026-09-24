import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import QuoPhoneTrigger from "@/components/leads/QuoPhoneTrigger";
import { useAuth } from "@/contexts/AuthContext";
import { fetchQuoChatThread } from "@/lib/quo-chat";
import { sendQuoMessageViaExtension } from "@/lib/quo-dashboard";

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: vi.fn(),
}));

vi.mock("@/lib/quo-chat", () => ({
  fetchQuoChatThread: vi.fn().mockResolvedValue({
    contact: { participant: "+15551234567" },
    phoneNumber: {
      id: "PN123",
      number: "+15551230000",
      formattedNumber: "+1 (555) 123-0000",
      name: "Main Line",
    },
    conversation: null,
    messages: [],
  }),
  sendQuoChatMessage: vi.fn(),
}));

vi.mock("@/lib/quo-dashboard", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/quo-dashboard")>();
  return {
    ...original,
    sendQuoMessageViaExtension: vi.fn().mockResolvedValue({ success: true }),
  };
});

describe("QuoPhoneTrigger", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("opens the Quo drawer for admins and shows a normalized phone number", async () => {
    vi.mocked(useAuth).mockReturnValue({
      role: "admin",
    } as unknown as ReturnType<typeof useAuth>);

    render(
      <QuoPhoneTrigger contactName="Jane Doe" phone="(555) 123-4567">
        (555) 123-4567
      </QuoPhoneTrigger>,
    );

    fireEvent.click(screen.getByRole("button", { name: /\(555\) 123-4567/i }));

    expect(await screen.findByText("No messages in this chat yet.")).toBeInTheDocument();
    expect(screen.getAllByText("(555) 123-4567").length).toBeGreaterThan(0);
    expect(screen.getByText("(Jane Doe)")).toBeInTheDocument();
    expect(fetchQuoChatThread).toHaveBeenCalledWith("+15551234567", undefined);
  });

  it("passes chat type when reloading the thread after sending", async () => {
    vi.mocked(useAuth).mockReturnValue({
      role: "admin",
      canAccess: vi.fn(() => true),
    } as unknown as ReturnType<typeof useAuth>);

    render(
      <QuoPhoneTrigger contactName="Jane Doe" phone="(555) 123-4567" chatType="customer">
        (555) 123-4567
      </QuoPhoneTrigger>,
    );

    fireEvent.click(screen.getByRole("button", { name: /\(555\) 123-4567/i }));

    const textarea = await screen.findByRole("textbox");
    fireEvent.change(textarea, { target: { value: "Hello there" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => {
      expect(vi.mocked(fetchQuoChatThread).mock.calls.at(-1)).toEqual(["+15551234567", "customer"]);
    });
  });

  it("sends the saved Quo conversation URL to the extension", async () => {
    vi.mocked(useAuth).mockReturnValue({
      role: "admin",
      canAccess: vi.fn(() => true),
    } as unknown as ReturnType<typeof useAuth>);
    vi.mocked(fetchQuoChatThread).mockResolvedValueOnce({
      contact: { participant: "+15551234567" },
      phoneNumber: {
        id: "PN123",
        number: "+15551230000",
        formattedNumber: "+1 (555) 123-0000",
        name: "Main Line",
      },
      conversation: {
        id: "CN_saved_conversation",
        phoneNumberId: "PN123",
        participants: ["+15551234567"],
      },
      messages: [],
    });

    render(
      <QuoPhoneTrigger contactName="Jane Doe" phone="(555) 123-4567">
        (555) 123-4567
      </QuoPhoneTrigger>,
    );
    fireEvent.click(screen.getByRole("button", { name: /\(555\) 123-4567/i }));

    const textarea = await screen.findByRole("textbox");
    fireEvent.change(textarea, { target: { value: "Use exact chat" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => {
      expect(sendQuoMessageViaExtension).toHaveBeenCalledWith(
        "https://my.quo.com/inbox/PN123/c/CN_saved_conversation",
        "Use exact chat",
      );
    });
  });

  it("renders plain text for non-admin users", () => {
    vi.mocked(useAuth).mockReturnValue({
      role: "customer_service",
    } as unknown as ReturnType<typeof useAuth>);

    render(
      <QuoPhoneTrigger contactName="Jane Doe" phone="(555) 123-4567">
        (555) 123-4567
      </QuoPhoneTrigger>,
    );

    expect(screen.queryByRole("button", { name: /\(555\) 123-4567/i })).not.toBeInTheDocument();
    expect(screen.getByText("(555) 123-4567")).toBeInTheDocument();
  });
});
