export type MarkupToken = { kind: "text" | "tag" | "attr" | "val"; text: string };

const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)([^<>]*)(>?)/g;
const ATTR_RE = /([^\s"'=<>/]+)(?:(\s*=\s*)(?:"([^"]*)("?)|'([^']*)('?)|([^\s"'<>]+))?)?/g;

/**
 * Split HTML or XML source into text, tag names, attribute names and attribute
 * values for highlighting. One pass over the original text: the tokens always
 * join back into the input, and nothing here is ever parsed as markup.
 */
export function tokenizeMarkup(source: string): MarkupToken[] {
  const out: MarkupToken[] = [];
  const push = (kind: MarkupToken["kind"], text: string | undefined) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.kind === kind && kind === "text") last.text += text;
    else out.push({ kind, text });
  };
  let at = 0;
  for (const tag of source.matchAll(TAG_RE)) {
    push("text", source.slice(at, tag.index));
    push("text", `<${tag[1]}`);
    push("tag", tag[2]);
    const rest = tag[3] ?? "";
    let seen = 0;
    for (const attr of rest.matchAll(ATTR_RE)) {
      push("text", rest.slice(seen, attr.index));
      push("attr", attr[1]);
      push("text", attr[2]);
      if (attr[3] !== undefined) {
        push("text", '"');
        push("val", attr[3]);
        push("text", attr[4]);
      } else if (attr[5] !== undefined) {
        push("text", "'");
        push("val", attr[5]);
        push("text", attr[6]);
      } else {
        push("val", attr[7]);
      }
      seen = attr.index + attr[0].length;
    }
    push("text", rest.slice(seen));
    push("text", tag[4]);
    at = tag.index + tag[0].length;
  }
  push("text", source.slice(at));
  return out;
}
