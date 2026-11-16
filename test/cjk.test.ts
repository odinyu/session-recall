import { expect, test } from "bun:test";
import { compactCjkWhitespace } from "../src/util/cjk.ts";

test("removes whitespace inside a Chinese phrase", () => {
  expect(compactCjkWhitespace("使用不 同的模型")).toBe("使用不同的模型");
  expect(compactCjkWhitespace("使用不\n同的模型")).toBe("使用不同的模型");
  expect(compactCjkWhitespace("使用不　同的模型")).toBe("使用不同的模型");
});

test("keeps whitespace that separates words of another script", () => {
  expect(compactCjkWhitespace("使用 Claude Code")).toBe("使用 Claude Code");
  expect(compactCjkWhitespace("git log --stat")).toBe("git log --stat");
  expect(compactCjkWhitespace("使用 Claude")).toBe("使用 Claude");
});

test("leaves already-compact text untouched", () => {
  expect(compactCjkWhitespace("使用不同的模型")).toBe("使用不同的模型");
  expect(compactCjkWhitespace("")).toBe("");
});
