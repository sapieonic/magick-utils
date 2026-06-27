import { readFileSync } from "node:fs";
import path from "node:path";
import { getBrandId } from "@/lib/brand";

// Serves the active brand's logo at runtime: GET /logo → brands/<id>/logo.png.
// Used by <Logo>, the collapsed sidebar mark, and the favicon (metadata.icons).
// Falls back to the bundled MagickVoice logo if the brand has no logo file.

export const dynamic = "force-dynamic";

function readLogo(id: string): Buffer {
  try {
    return readFileSync(path.join(process.cwd(), "brands", id, "logo.png"));
  } catch {
    return readFileSync(path.join(process.cwd(), "public", "logo.png"));
  }
}

export function GET() {
  const body = readLogo(getBrandId());
  return new Response(new Uint8Array(body), {
    headers: {
      "Content-Type": "image/png",
      // Short cache: the brand is fixed per deployment, but keep it modest so a
      // re-deploy with a new logo doesn't serve a stale icon for long.
      "Cache-Control": "public, max-age=300",
    },
  });
}
