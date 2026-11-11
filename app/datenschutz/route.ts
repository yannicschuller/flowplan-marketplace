import { legalRedirect } from "@/lib/legal";

// The text lives on the Flowplan website (MARKETPLACE_PRIVACY_URL).
export const dynamic = "force-dynamic";
export function GET(request: Request) {
  return legalRedirect("datenschutz", request);
}
