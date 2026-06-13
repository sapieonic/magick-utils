// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Icon, cx } from "@/components/ui/icon";

describe("cx", () => {
  it("joins truthy class strings", () => {
    expect(cx("a", "b", "c")).toBe("a b c");
  });
  it("skips falsy values (false, null, undefined, empty string)", () => {
    expect(cx("a", false, null, undefined, "", "b")).toBe("a b");
  });
  it("returns empty string when all falsy", () => {
    expect(cx(false, null, undefined)).toBe("");
  });
});

describe("Icon", () => {
  it("renders an svg element for a valid lucide name", () => {
    const { container } = render(<Icon name="Download" />);
    const svg = container.querySelector("svg");
    expect(svg).toBeInTheDocument();
  });

  it("resolves aliased legacy names (CheckCircle2 -> CircleCheck)", () => {
    const { container } = render(<Icon name="CheckCircle2" />);
    expect(container.querySelector("svg")).toBeInTheDocument();
  });

  it("degrades gracefully for an unknown name: renders an empty span placeholder (no svg)", () => {
    const { container } = render(<Icon name="DefinitelyNotARealIconName" className="ph" />);
    expect(container.querySelector("svg")).toBeNull();
    const span = container.querySelector("span.ph");
    expect(span).toBeInTheDocument();
    // placeholder keeps the requested box size
    expect(span).toHaveStyle({ display: "inline-block" });
  });

  it("passes size to a valid icon (width/height attr on svg)", () => {
    const { container } = render(<Icon name="Phone" size={30} />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("width")).toBe("30");
    expect(svg.getAttribute("height")).toBe("30");
  });
});
