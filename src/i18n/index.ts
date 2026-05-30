export type Locale = "zh-CN" | "en-US";

export interface TranslationDict {
  [key: string]: string | TranslationDict;
}

const dictionaries: Partial<Record<Locale, TranslationDict>> = {};

let currentLocale: Locale = "zh-CN";

const listeners = new Set<() => void>();

export function getLocale(): Locale {
  return currentLocale;
}

export function setLocale(locale: Locale) {
  if (locale === currentLocale) return;
  currentLocale = locale;
  for (const listener of listeners) {
    listener();
  }
}

export function onLocaleChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function registerLocale(locale: Locale, dict: TranslationDict) {
  dictionaries[locale] = dict;
}

function resolve(obj: TranslationDict, path: string): string {
  const keys = path.split(".");
  let current: TranslationDict | string = obj;
  for (const key of keys) {
    if (typeof current === "string") return path;
    current = current[key];
    if (current === undefined) return path;
  }
  return typeof current === "string" ? current : path;
}

export function t(key: string, params?: Record<string, string | number>): string {
  const dict = dictionaries[currentLocale] ?? {};
  let text = resolve(dict, key);
  if (text === key) {
    const fallback = dictionaries["zh-CN"];
    if (fallback) {
      text = resolve(fallback, key);
    }
  }
  if (params) {
    for (const [paramKey, paramValue] of Object.entries(params)) {
      text = text.replace(new RegExp(`\\{${paramKey}\\}`, "g"), String(paramValue));
    }
  }
  return text;
}
