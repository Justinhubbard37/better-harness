import { createHighlighterCore, type HighlighterCore, type LanguageInput, type ThemeRegistrationRaw } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import { studioCodeLanguage, type StudioCodeLanguage } from "./code-rendering-model.js";

export interface StudioCodeToken {
  content: string;
  color?: string;
  fontStyle?: number;
}

const languageLoaders: Record<StudioCodeLanguage, () => Promise<{ default: LanguageInput }>> = {
  css: () => import("@shikijs/langs/css"),
  html: () => import("@shikijs/langs/html"),
  javascript: () => import("@shikijs/langs/javascript"),
  json: () => import("@shikijs/langs/json"),
  shellscript: () => import("@shikijs/langs/shellscript"),
  tsx: () => import("@shikijs/langs/tsx"),
  typescript: () => import("@shikijs/langs/typescript"),
};

const studioLightTheme: ThemeRegistrationRaw = {
  name: "harness-studio-light",
  type: "light",
  settings: [],
  colors: {
    "editor.background": "#ffffff",
    "editor.foreground": "#27334a",
  },
  tokenColors: [
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "#718096", fontStyle: "italic" } },
    { scope: ["string", "string.quoted", "string.template"], settings: { foreground: "#0b7a55" } },
    { scope: ["constant.numeric", "constant.language", "constant.character"], settings: { foreground: "#8b5b13" } },
    { scope: ["keyword", "storage", "storage.type"], settings: { foreground: "#7541b2" } },
    { scope: ["entity.name.function", "support.function", "meta.function-call"], settings: { foreground: "#125fb4" } },
    { scope: ["entity.name.type", "support.type", "support.class"], settings: { foreground: "#9a4a18" } },
    { scope: ["variable", "meta.object-literal.key", "support.variable.property"], settings: { foreground: "#27334a" } },
  ],
};

let highlighterPromise: Promise<HighlighterCore> | undefined;
const languagePromises = new Map<StudioCodeLanguage, Promise<void>>();

/** Highlight code lazily; unknown or failed languages preserve a plain-text fallback. */
export async function highlightStudioCode(
  code: string,
  sourceHint: string,
): Promise<readonly (readonly StudioCodeToken[])[] | undefined> {
  const language = studioCodeLanguage(sourceHint);
  if (language === undefined || code.length === 0) return undefined;
  try {
    const highlighter = await getHighlighter();
    await ensureLanguage(highlighter, language);
    return highlighter.codeToTokensBase(code, { lang: language, theme: studioLightTheme.name })
      .map((line) => compactTokens(line));
  } catch {
    return undefined;
  }
}

function getHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= createHighlighterCore({
    themes: [studioLightTheme],
    langs: [],
    engine: createJavaScriptRegexEngine(),
  });
  return highlighterPromise;
}

function ensureLanguage(highlighter: HighlighterCore, language: StudioCodeLanguage): Promise<void> {
  let pending = languagePromises.get(language);
  if (pending === undefined) {
    pending = languageLoaders[language]().then((module) => highlighter.loadLanguage(module.default));
    languagePromises.set(language, pending);
  }
  return pending;
}

function compactTokens(tokens: readonly StudioCodeToken[]): readonly StudioCodeToken[] {
  const compacted: StudioCodeToken[] = [];
  for (const token of tokens) {
    const previous = compacted.at(-1);
    if (previous !== undefined && previous.color === token.color && previous.fontStyle === token.fontStyle) {
      compacted[compacted.length - 1] = { ...previous, content: previous.content + token.content };
    } else {
      compacted.push({ content: token.content, color: token.color, fontStyle: token.fontStyle });
    }
  }
  return compacted;
}
