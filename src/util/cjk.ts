const CJK = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/u;
const SPACE = /[\s\u3000]/u;

/**
 * Drop whitespace that sits between two CJK characters. Transcripts wrap long
 * lines, so 「使用不同的模型协同」 can be stored as 「使用不 同的模型协同」;
 * searching the unbroken phrase must still find it.
 */
export function compactCjkWhitespace(text: string): string {
  if (!SPACE.test(text)) return text;
  const chars = [...text];
  const out: string[] = [];
  for (let i = 0; i < chars.length; ) {
    const ch = chars[i] as string;
    if (!SPACE.test(ch)) {
      out.push(ch);
      i++;
      continue;
    }
    let end = i;
    while (end < chars.length && SPACE.test(chars[end] as string)) end++;
    const prev = out.at(-1);
    const next = chars[end];
    if (prev !== undefined && next !== undefined && CJK.test(prev) && CJK.test(next)) {
      i = end;
      continue;
    }
    out.push(...chars.slice(i, end));
    i = end;
  }
  return out.join("");
}
