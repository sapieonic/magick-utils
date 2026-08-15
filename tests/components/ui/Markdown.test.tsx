// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Markdown } from "@/components/ui/Markdown";

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

  it("styles deeper headings instead of leaving browser defaults", () => {
    render(<Markdown>{"#### Deep heading"}</Markdown>);
    expect(screen.getByRole("heading", { level: 4, name: "Deep heading" })).toHaveClass("text-[13px]");
  });

  it("preserves single newlines as line breaks", () => {
    render(<Markdown>{"The success rate is 11.2%.\nThe no-answer rate is 17.7%."}</Markdown>);

    const paragraph = screen.getByText(/The success rate is 11.2%/).closest("p");
    expect(paragraph?.querySelector("br")).toBeInTheDocument();
    expect(paragraph?.textContent).toContain("The no-answer rate is 17.7%.");
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

  it("opens http(s) links in a new tab and leaves in-page links in-place", () => {
    render(<Markdown>{"See [the docs](https://example.com/guide) and [this section](#notes)."}</Markdown>);

    const external = screen.getByRole("link", { name: "the docs" });
    expect(external).toHaveAttribute("href", "https://example.com/guide");
    expect(external).toHaveAttribute("target", "_blank");
    expect(external).toHaveAttribute("rel", "noopener noreferrer");

    const local = screen.getByRole("link", { name: "this section" });
    expect(local).toHaveAttribute("href", "#notes");
    expect(local).not.toHaveAttribute("target");
  });

  it("does not turn javascript: or empty URLs into navigable links", () => {
    render(<Markdown>{"Click [here](javascript:alert(1)) or [nowhere]()."}</Markdown>);

    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("here").tagName).toBe("SPAN");
    expect(screen.getByText("nowhere").tagName).toBe("SPAN");
  });

  it("does not render images", () => {
    render(<Markdown>{"Before ![chart](https://evil.example/pixel.png) after"}</Markdown>);

    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText(/Before/)).toBeInTheDocument();
    expect(screen.getByText(/after/)).toBeInTheDocument();
  });

  it("drops the extra disc marker on GFM task lists", () => {
    render(<Markdown>{"- [ ] Follow up with no-answers"}</Markdown>);

    const item = screen.getByText("Follow up with no-answers").closest("li");
    expect(item).toHaveClass("task-list-item");
    expect(item).toHaveClass("[&.task-list-item]:list-none");
    expect(item?.closest("ul")).toHaveClass("contains-task-list");
    expect(item?.closest("ul")).toHaveClass("[&.contains-task-list]:list-none");
  });
});
