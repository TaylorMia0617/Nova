import { useSyncExternalStore } from "react";
import { getLocale, onLocaleChange, t } from "../i18n";

export function useTranslation() {
  useSyncExternalStore(onLocaleChange, getLocale);
  return { t, locale: getLocale() };
}
