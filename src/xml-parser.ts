// A small strict XML reader for tests; it is not used at run time.

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Decodes `#123` or `#x1F`; the code point must be a legal XML 1.0 character. */
function decodeReference(name: string): string {
  const cp = name.startsWith("#x") ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
  if (!Number.isSafeInteger(cp) || !isLegalCodePoint(cp)) {
    throw new Error(`illegal character reference &${name};`);
  }
  return String.fromCodePoint(cp);
}

/** Decodes the five predefined and numeric entities; any other `&` is an error. */
function decode(raw: string): string {
  const out = raw.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (whole, name: string) => {
    if (name.startsWith("#")) return decodeReference(name);
    return Object.hasOwn(NAMED, name) ? (NAMED[name] ?? whole) : whole;
  });
  // Any entity left over was not one of the allowed forms; a decoded "&" cannot be told apart
  // here, so check the raw text instead.
  if (raw.replace(/&(amp|lt|gt|quot|apos|#x[0-9a-fA-F]+|#\d+);/g, "").includes("&")) {
    throw new Error("bad entity");
  }
  return out;
}

function isLegalCodePoint(cp: number): boolean {
  return (
    cp === 9 ||
    cp === 10 ||
    cp === 13 ||
    (cp >= 0x20 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff)
  );
}

function assertLegalChars(xml: string): void {
  for (const ch of xml) {
    const cp = ch.codePointAt(0) ?? 0;
    if (!isLegalCodePoint(cp)) throw new Error(`illegal character U+${cp.toString(16)}`);
  }
}

const ATTRIBUTE = /^\s+([\w:-]+)="([^"<]*)"/;

/** Parses the inside of a start tag (after the name) into attributes; the rest must be empty. */
function parseAttributes(rest: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  let remaining = rest;
  for (let m = ATTRIBUTE.exec(remaining); m !== null; m = ATTRIBUTE.exec(remaining)) {
    const attrName = m[1] ?? "";
    if (Object.hasOwn(attrs, attrName)) throw new Error(`duplicate attribute ${attrName}`);
    attrs[attrName] = decode(m[2] ?? "");
    remaining = remaining.slice(m[0].length);
  }
  if (remaining.trim() !== "") throw new Error("bad attribute");
  return attrs;
}

function openTag(inner: string, parent: XmlNode, stack: XmlNode[]): void {
  const isEmpty = inner.endsWith("/");
  const body = isEmpty ? inner.slice(0, -1) : inner;
  const nameEnd = body.search(/\s|$/);
  const name = body.slice(0, nameEnd);
  if (!/^[A-Za-z][\w:-]*$/.test(name)) throw new Error(`bad name ${name}`);
  const node: XmlNode = {
    name,
    attrs: parseAttributes(body.slice(nameEnd)),
    children: [],
    text: "",
  };
  parent.children.push(node);
  if (!isEmpty) stack.push(node);
}

function readText(body: string, pos: number, top: XmlNode, isRoot: boolean): number {
  const next = body.indexOf("<", pos);
  const text = body.slice(pos, next < 0 ? body.length : next);
  if (isRoot && text.trim() !== "") throw new Error("text outside root");
  top.text += decode(text);
  return pos + text.length;
}

function readTag(body: string, pos: number, stack: XmlNode[]): number {
  const top = stack[stack.length - 1];
  const end = body.indexOf(">", pos);
  if (top === undefined || end < 0) throw new Error("unterminated tag");
  const inner = body.slice(pos + 1, end);
  if (!inner.startsWith("/")) {
    openTag(inner, top, stack);
  } else if (top.name === inner.slice(1)) {
    stack.pop();
  } else {
    throw new Error(`mismatched </${inner.slice(1)}>`);
  }
  return end + 1;
}

/** Strict parser: one root, proper nesting, quoted attributes, five entities, no CDATA. */
export function parseXml(xml: string): XmlNode {
  assertLegalChars(xml);
  const body = xml.replace(/^<\?xml[^>]*\?>\s*/, "");
  const root: XmlNode = { name: "#root", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  let pos = 0;
  while (pos < body.length) {
    const top = stack[stack.length - 1];
    if (top === undefined) throw new Error("stack empty");
    pos =
      body.charAt(pos) === "<" ? readTag(body, pos, stack) : readText(body, pos, top, top === root);
  }
  if (stack.length !== 1) throw new Error("unclosed element");
  const only = root.children[0];
  if (root.children.length !== 1 || only === undefined) throw new Error("need exactly one root");
  return only;
}

export function child(node: XmlNode, name: string): XmlNode {
  const found = node.children.find((c) => c.name === name);
  if (found === undefined) throw new Error(`missing <${name}>`);
  return found;
}
