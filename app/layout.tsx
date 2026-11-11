import type { Metadata, Viewport } from "next";
import "./globals.css";
import { pageLocale } from "@/lib/page";
import { config } from "@/lib/config";
import { LocaleProvider } from "@/components/i18n";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { translate } from "@/lib/i18n";

export async function generateMetadata(): Promise<Metadata> {
  const t = translate(await pageLocale());
  return {
    metadataBase: new URL(config.publicUrl()),
    title: { default: "Flowplan Marketplace", template: "%s · Flowplan Marketplace" },
    description: t(
      "Vorlagen, Workflows und Erscheinungsbilder für Flowplan – von der Community geteilt, vor der Veröffentlichung geprüft.",
      "Templates, workflows and looks for Flowplan – shared by the community, reviewed before they are published.",
    ),
    applicationName: "Flowplan Marketplace",
    icons: { icon: [{ url: "/icon.svg", type: "image/svg+xml" }, { url: "/icons/icon-192.png", type: "image/png", sizes: "192x192" }], apple: "/icons/apple-touch-icon.png" },
  };
}
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fcfbf8" },
    { media: "(prefers-color-scheme: dark)", color: "#16151b" },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await pageLocale();
  return (
    <html lang={locale}>
      <head>
        <link rel="preload" href="/fonts/instrument-sans-latin-standard-normal.woff2" as="font" type="font/woff2" crossOrigin="" />
        <link rel="stylesheet" href="/fonts.css" />
      </head>
      <body>
        <LocaleProvider locale={locale}>
          <a className="skip" href="#main">
            {translate(locale)("Zum Inhalt", "Skip to content")}
          </a>
          <SiteHeader />
          <main id="main">{children}</main>
          <SiteFooter />
        </LocaleProvider>
      </body>
    </html>
  );
}
