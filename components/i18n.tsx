"use client";
// The visitor's language for client components.
import { createContext, useContext } from "react";
import { translate, type Locale } from "@/lib/i18n";

const LocaleContext = createContext<Locale>("en");
export function LocaleProvider({ locale, children }: { locale: Locale; children: React.ReactNode }) {
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}
export const useLocale = () => useContext(LocaleContext);
export const useT = () => translate(useContext(LocaleContext));
