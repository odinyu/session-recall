import { expect, test } from "bun:test";
import { isLangPref, MESSAGES, resolveLang, format } from "../web/i18n.ts";

/**
 * `Messages` derives its shape from the Chinese dictionary, so a missing
 * English key is a type error — but `bun run build` strips types without
 * checking them and `bun test` never imported this module, which left the gap
 * these tests close: a forgotten key used to render as `undefined` in the UI.
 */

const zh = MESSAGES.zh as unknown as Record<string, string>;
const en = MESSAGES.en as unknown as Record<string, string>;

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string).sort();
}

test("both languages define exactly the same keys", () => {
  expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
});

test("every key has a non-empty string in both languages", () => {
  for (const key of Object.keys(zh)) {
    expect(typeof zh[key]).toBe("string");
    expect(typeof en[key]).toBe("string");
    expect((zh[key] as string).length).toBeGreaterThan(0);
    expect((en[key] as string).length).toBeGreaterThan(0);
  }
});

test("placeholders match per key, so one language cannot drop a value", () => {
  for (const key of Object.keys(zh)) {
    expect({ key, names: placeholders(zh[key] as string) }).toEqual({
      key,
      names: placeholders(en[key] as string),
    });
  }
});

test("the English dictionary carries no CJK characters", () => {
  for (const [key, value] of Object.entries(en)) {
    expect({ key, cjk: /[\u3400-\u9fff\uff00-\uff60]/.test(value) }).toEqual({
      key,
      cjk: false,
    });
  }
});

test("format fills known names and leaves unknown ones written", () => {
  expect(format("2 sessions · {turns} turns", { turns: 5 })).toBe("2 sessions · 5 turns");
  expect(format("{missing} stays", {})).toBe("{missing} stays");
  expect(format("{value} and {value}", { value: 1 })).toBe("1 and 1");
});

test("resolveLang follows the preference, then the browser language", () => {
  expect(resolveLang("zh", ["en-US"])).toBe("zh");
  expect(resolveLang("en", ["zh-CN"])).toBe("en");
  expect(resolveLang("auto", ["zh-CN", "en"])).toBe("zh");
  expect(resolveLang("auto", ["en-US"])).toBe("en");
  expect(resolveLang("auto", [])).toBe("en");
  expect(isLangPref("auto")).toBe(true);
  expect(isLangPref("fr")).toBe(false);
});
