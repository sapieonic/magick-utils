// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

// streamChat is the only side-effecting dependency — mock it so tests are
// deterministic (no real fetch / SSE). Each test sets its own implementation.
vi.mock("@/lib/api", () => ({ streamChat: vi.fn() }));

import { ChatPanel } from "@/components/screens/analytics/ChatPanel";
import { streamChat } from "@/lib/api";
import { CAMPAIGNS } from "@/lib/data";
import type { Batch } from "@/lib/types";

const mockStreamChat = vi.mocked(streamChat);

const one: Batch[] = [CAMPAIGNS[0]];
const two: Batch[] = [CAMPAIGNS[0], CAMPAIGNS[1]];

/** Render the panel open with sensible defaults; returns the onClose spy. */
function renderPanel(props: Partial<React.ComponentProps<typeof ChatPanel>> = {}) {
  const onClose = vi.fn();
  const utils = render(
    <ChatPanel targets={one} batchIds={[one[0].id]} open onClose={onClose} {...props} />,
  );
  return { onClose, ...utils };
}

beforeEach(() => {
  mockStreamChat.mockReset();
});

describe("ChatPanel — scope label", () => {
  it("shows the single campaign name it is grounded on", () => {
    renderPanel({ targets: one });
    // Appears in both the header and the empty-state intro.
    expect(screen.getAllByText(one[0].name).length).toBeGreaterThan(0);
  });

  it("summarizes multiple campaigns as a count", () => {
    renderPanel({ targets: two, batchIds: two.map((b) => b.id) });
    expect(screen.getAllByText("2 campaigns").length).toBeGreaterThan(0);
  });
});

describe("ChatPanel — empty state & suggestions", () => {
  it("renders starter prompts before any conversation", () => {
    renderPanel();
    expect(screen.getByText("Ask about this campaign")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Why did this batch underperform\?/ })).toBeInTheDocument();
  });

  it("clicking a suggestion sends it through streamChat with the batch ids and renders both turns", async () => {
    mockStreamChat.mockImplementation(async (_ids: string[], _msg: string, _history: { role: "user" | "assistant"; content: string }[], onDelta: (text: string) => void) => {
      onDelta("Because the dialer was throttled.");
      return true; // live path
    });
    renderPanel({ batchIds: ["b_1", "b_2"] });

    fireEvent.click(screen.getByRole("button", { name: /What is the best time to call\?/ }));

    // The chosen prompt becomes the user turn…
    expect(screen.getByText("What is the best time to call?")).toBeInTheDocument();
    // …and is forwarded with the exact batch ids.
    expect(mockStreamChat).toHaveBeenCalledTimes(1);
    expect(mockStreamChat.mock.calls[0][0]).toEqual(["b_1", "b_2"]);
    expect(mockStreamChat.mock.calls[0][1]).toBe("What is the best time to call?");

    // The streamed assistant reply lands.
    await waitFor(() => expect(screen.getByText("Because the dialer was throttled.")).toBeInTheDocument());
  });

  it("renders assistant markdown (headings, bold, tables) instead of raw syntax", async () => {
    mockStreamChat.mockImplementation(async (_ids: string[], _msg: string, _history: { role: "user" | "assistant"; content: string }[], onDelta: (text: string) => void) => {
      onDelta(
        "## What the data shows\n\nThe batch has a **low connect rate**.\n\n| Metric | Value |\n|---|---|\n| Success rate | 11.2% |\n",
      );
      return true;
    });
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /Why did this batch underperform\?/ }));

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "What the data shows" })).toBeInTheDocument();
    });
    expect(screen.getByText("low connect rate").tagName).toBe("STRONG");
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Metric" })).toBeInTheDocument();
    expect(screen.queryByText("## What the data shows")).not.toBeInTheDocument();
  });

  it("leaves user messages as literal text, not markdown", async () => {
    mockStreamChat.mockImplementation(async (_ids: string[], _msg: string, _history: { role: "user" | "assistant"; content: string }[], onDelta: (text: string) => void) => {
      onDelta("Noted.");
      return true;
    });
    renderPanel();

    const input = screen.getByPlaceholderText(/Ask anything about this campaign/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "See **bold** please" } });
    fireEvent.submit(input.closest("form")!);

    expect(screen.getByText("See **bold** please")).toBeInTheDocument();
    expect(screen.getByText("See **bold** please").querySelector("strong")).toBeNull();
    await waitFor(() => expect(screen.getByText("Noted.")).toBeInTheDocument());
  });

  it("shows a streaming caret until the assistant turn settles", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockStreamChat.mockImplementation(async (_ids: string[], _msg: string, _history: { role: "user" | "assistant"; content: string }[], onDelta: (text: string) => void) => {
      await gate;
      onDelta("Done.");
      return true;
    });
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /What is the best time to call\?/ }));
    await waitFor(() => expect(document.querySelector(".caret")).toBeInTheDocument());

    release();
    await waitFor(() => expect(screen.getByText("Done.")).toBeInTheDocument());
    expect(document.querySelector(".caret")).toBeNull();
  });
});

describe("ChatPanel — composer", () => {
  it("submits typed input and clears the field", async () => {
    mockStreamChat.mockImplementation(async (_ids: string[], _msg: string, _history: { role: "user" | "assistant"; content: string }[], onDelta: (text: string) => void) => {
      onDelta("Answer.");
      return true;
    });
    renderPanel();

    const input = screen.getByPlaceholderText(/Ask anything about this campaign/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "How is sentiment trending?" } });
    fireEvent.submit(input.closest("form")!);

    expect(mockStreamChat).toHaveBeenCalledTimes(1);
    expect(screen.getByText("How is sentiment trending?")).toBeInTheDocument();
    await waitFor(() => expect(input.value).toBe(""));
  });

  it("shows an explicit error instead of a canned answer when AI is unavailable", async () => {
    mockStreamChat.mockResolvedValue(false);
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /Why did this batch underperform\?/ }));

    await waitFor(() => expect(screen.getByText(/couldn't reach the assistant/i)).toBeInTheDocument());
    expect(screen.queryByText(/Two things held this batch back/)).not.toBeInTheDocument();
  });
});

describe("ChatPanel — clear", () => {
  it("wipes the conversation back to the empty state", async () => {
    mockStreamChat.mockImplementation(async (_ids: string[], _msg: string, _history: { role: "user" | "assistant"; content: string }[], onDelta: (text: string) => void) => {
      onDelta("Settled answer.");
      return true;
    });
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /Summarize the negative conversations/ }));
    await waitFor(() => expect(screen.getByText("Settled answer.")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /Clear/ }));

    // Conversation gone, starter prompts back.
    expect(screen.queryByText("Settled answer.")).not.toBeInTheDocument();
    expect(screen.getByText("Ask about this campaign")).toBeInTheDocument();
  });
});

describe("ChatPanel — close affordances", () => {
  it("calls onClose when the X button is clicked", () => {
    const { onClose } = renderPanel();
    fireEvent.click(screen.getByTitle("Close (Esc)"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose on Escape while open and idle", () => {
    const { onClose } = renderPanel();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not bind Escape when closed", () => {
    const { onClose } = renderPanel({ open: false });
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});
