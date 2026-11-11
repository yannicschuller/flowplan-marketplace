import { legalRedirect } from "@/lib/legal";

// The text lives on the Flowplan website (MARKETPLACE_IMPRESSUM_URL).
export const dynamic = "force-dynamic";
export function GET(request: Request) {
  return legalRedirect("impressum", request);
}
