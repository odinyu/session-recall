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

test("renders tables", () => {
  const html = renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |");
  expect(html).toContain("<table>");
  expect(html).toContain("<th>a</th>");
  expect(html).toContain("<td>2</td>");
});
