// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

// next/image renders a real <img>; stub to a plain img to avoid the optimizer.
vi.mock("next/image", () => ({
  default: (props: Record<string, unknown>) => {
    // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
    return <img {...(props as Record<string, string>)} />;
  },
}));

import { Logo } from "@/components/Logo";

describe("Logo", () => {
  it("renders the wordmark by default", () => {
    render(<Logo />);
    expect(screen.getByText("Magick")).toBeInTheDocument();
    expect(screen.getByText("Utils")).toBeInTheDocument();
    expect(screen.getByText("by MagickVoice")).toBeInTheDocument();
  });

  it("renders the logo image with alt text", () => {
    render(<Logo />);
    expect(screen.getByAltText("MagickUtils")).toBeInTheDocument();
  });

  it("hides the wordmark when withWordmark is false", () => {
    render(<Logo withWordmark={false} />);
    expect(screen.queryByText("by MagickVoice")).not.toBeInTheDocument();
  });

  it("applies light text class when light", () => {
    render(<Logo light />);
    expect(screen.getByText("by MagickVoice")).toHaveClass("text-white/60");
  });
});
