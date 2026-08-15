// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Markdown } from "@/components/ui";

describe("Markdown", () => {
  it("renders headings, emphasis, and lists", () => {
    render(
      <Markdown>{`## What the data shows

I **cannot explain** why it underperformed.

- reachability issues
- low connect rate
`}</Markdown>,
    );

    expect(screen.getByRole("heading", { level: 2, name: "What the data shows" })).toBeInTheDocument();
    expect(screen.getByText("cannot explain").tagName).toBe("STRONG");
    expect(screen.getByText("reachability issues").closest("li")).toBeInTheDocument();
    expect(screen.getByText("low connect rate").closest("ul")).toBeInTheDocument();
  });

  it("renders GFM tables", () => {
    render(
      <Markdown>{`| Metric | Value |
|---|---|
| **Success rate** | **11.2%** |
| No-answer rate | 17.7% |
`}</Markdown>,
    );

    const table = screen.getByRole("table");
    expect(table).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Metric" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Value" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "Success rate" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "11.2%" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "17.7%" })).toBeInTheDocument();
  });

  it("does not execute raw HTML", () => {
    render(<Markdown>{"Hello <script>window.__md_xss=1</script> **world**"}</Markdown>);

    expect(screen.getByText("world").tagName).toBe("STRONG");
    expect(document.querySelector("script")).toBeNull();
    expect((window as unknown as { __md_xss?: number }).__md_xss).toBeUndefined();
  });

  it("opens links in a new tab", () => {
    render(<Markdown>{"See [the docs](https://example.com/guide)."}</Markdown>);

    const link = screen.getByRole("link", { name: "the docs" });
    expect(link).toHaveAttribute("href", "https://example.com/guide");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });
});
