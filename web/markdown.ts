const CODE_TOKEN = "\u0000C";
const INLINE_TOKEN = "\u0001I";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function inline(text: string, codeBlocks: string[]): string {
  const inlineCodes: string[] = [];
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, (_match, code: string) => {
    const token = `${INLINE_TOKEN}${inlineCodes.length}\u0001`;
    inlineCodes.push(`<code>${code}</code>`);
    return token;
  });
  // Web links open in the system browser; the app's own `sessionrecall://` deep
  // link is resolved in place by the delegated click handler in app.ts, so it
  // gets no `target` and never leaves the document.
  out = out.replace(
    /\[([^\]]+)\]\(((?:https?|sessionrecall):\/\/[^\s)]+)\)/gi,
    (_match, label: string, href: string) =>
      /^https?:/i.test(href)
        ? `<a href="${escapeAttr(href)}" target="_blank" rel="noreferrer">${label}</a>`
        : `<a href="${escapeAttr(href)}">${label}</a>`,
  );
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  out = out.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  for (const [index, code] of inlineCodes.entries()) {
    out = out.replace(`${INLINE_TOKEN}${index}\u0001`, code);
  }
  for (const [index, code] of codeBlocks.entries()) {
    out = out.replace(`${CODE_TOKEN}${index}\u0000`, code);
  }
  return out;
}

function tableHtml(lines: string[], codeBlocks: string[]): string {
  const rows = lines
    .filter((line) => !/^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line))
    .map((line) =>
      line
        .replace(/^\s*\|/, "")
        .replace(/\|\s*$/, "")
        .split("|")
        .map((cell) => cell.trim()),
    );
  if (rows.length === 0) return "";
  const [head, ...body] = rows;
  const thead = `<thead><tr>${head.map((cell) => `<th>${inline(cell, codeBlocks)}</th>`).join("")}</tr></thead>`;
  const tbody = body
    .map((row) => `<tr>${row.map((cell) => `<td>${inline(cell, codeBlocks)}</td>`).join("")}</tr>`)
    .join("");
  return `<div class="table-wrap"><table>${thead}<tbody>${tbody}</tbody></table></div>`;
}

function isTableStart(lines: string[], index: number): boolean {
  const line = lines[index] ?? "";
  const next = lines[index + 1] ?? "";
  return (
    line.includes("|") &&
    /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(next) &&
    next.includes("-") &&
    !/^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line)
  );
}

function isBlockStart(line: string): boolean {
  return (
    /^#{1,4}\s+/.test(line) ||
    /^\s*>\s?/.test(line) ||
    /^\s*([-*]|\d+\.)\s+/.test(line) ||
    /^\s*```/.test(line) ||
    /^\s*---+\s*$/.test(line)
  );
}

export function renderMarkdown(source: string): string {
  const codeBlocks: string[] = [];
  const text = source.replace(/```([\w-]*)\r?\n([\s\S]*?)```/g, (_match, lang: string, code: string) => {
    const language = /^[a-z0-9-]+$/i.test(lang) ? ` class="language-${lang}"` : "";
    const token = `${CODE_TOKEN}${codeBlocks.length}\u0000`;
    codeBlocks.push(`<pre><code${language}>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`);
    return token;
  });

  const lines = text.split("\n");
  const out: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index++;
      continue;
    }
    if (line.startsWith(CODE_TOKEN)) {
      out.push(line);
      index++;
      continue;
    }
    if (/^#{1,4}\s+/.test(line)) {
      const level = Math.min(4, (line.match(/^#+/)?.[0].length ?? 1) + 1);
      out.push(`<h${level}>${inline(line.replace(/^#{1,4}\s+/, ""), codeBlocks)}</h${level}>`);
      index++;
      continue;
    }
    if (/^\s*---+\s*$/.test(line)) {
      out.push("<hr>");
      index++;
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index] ?? "")) {
        quote.push((lines[index] ?? "").replace(/^\s*>\s?/, ""));
        index++;
      }
      out.push(`<blockquote>${inline(quote.join("\n"), codeBlocks).replace(/\n/g, "<br>")}</blockquote>`);
      continue;
    }
    if (isTableStart(lines, index)) {
      const table: string[] = [];
      while (index < lines.length && (lines[index] ?? "").includes("|")) {
        table.push(lines[index] ?? "");
        index++;
      }
      out.push(tableHtml(table, codeBlocks));
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items: string[] = [];
      while (index < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[index] ?? "")) {
        items.push((lines[index] ?? "").replace(/^\s*([-*]|\d+\.)\s+/, ""));
        index++;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map((item) => `<li>${inline(item, codeBlocks)}</li>`).join("")}</${tag}>`);
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? "";
      if (!current.trim() || isBlockStart(current) || current.startsWith(CODE_TOKEN) || isTableStart(lines, index)) break;
      paragraph.push(current);
      index++;
    }
    if (paragraph.length === 0) {
      index++;
      continue;
    }
    out.push(`<p>${inline(paragraph.join("\n"), codeBlocks).replace(/\n/g, "<br>")}</p>`);
  }

  const html = out.join("\n");
  return html.replace(/\u0000C(\d+)\u0000/g, (_match, index: string) => codeBlocks[Number(index)] ?? "");
}
