import { expect, test } from "bun:test";
import { renderMarkdown } from "../web/markdown.ts";

test("renders common markdown and escapes HTML", () => {
  const html = renderMarkdown(
    "# Title\n\n**bold** and `code`\n\n- one\n- two\n\n```ts\nconst x = '<b>';\n```",
  );
  expect(html).toContain("<h2>Title</h2>");
  expect(html).toContain("<strong>bold</strong>");
  expect(html).toContain("<code>code</code>");
  expect(html).toContain("<ul><li>one</li><li>two</li></ul>");
  expect(html).toContain("&lt;b&gt;");
  expect(html).not.toContain("<b>");
});

test("escapes injected HTML", () => {
  const html = renderMarkdown('<script>alert("x")</script>');
  expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;script&gt;");
});

test("renders deep links as in-app anchors, web links as external ones", () => {
  const html = renderMarkdown(
    "[在 session-recall 打开](sessionrecall://session/alma%3Athread%3A1) · [web](https://example.com/)",
  );
  expect(html).toContain(
    '<a href="sessionrecall://session/alma%3Athread%3A1">在 session-recall 打开</a>',
  );
  // The deep link must not be handed to the system browser, so no target.
  expect(html).not.toContain('href="sessionrecall://session/alma%3Athread%3A1" target');
  expect(html).toContain(
    '<a href="https://example.com/" target="_blank" rel="noreferrer">web</a>',
  );
});

test("renders tables", () => {
  const html = renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |");
  expect(html).toContain("<table>");
  expect(html).toContain("<th>a</th>");
  expect(html).toContain("<td>2</td>");
});
