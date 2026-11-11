import { permanentRedirect } from "next/navigation";
import { LegalPage } from "@/components/legal-page";
import { config } from "@/lib/config";

export const metadata = { title: "Nutzungsbedingungen / Terms of use" };
// Per request: MARKETPLACE_TERMS_URL and the operator's file are read at runtime.
export const dynamic = "force-dynamic";

export default function Page() {
  const url = config.termsUrl();
  if (url) permanentRedirect(url);
  return <LegalPage />;
}
