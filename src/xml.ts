function isXmlChar(cp: number): boolean {
  return (
    cp === 0x9 ||
    cp === 0xa ||
    cp === 0xd ||
    (cp >= 0x20 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff)
  );
}

const ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

/**
 * Text safe for XML 1.0 element content and quoted attributes. Characters that XML forbids
 * (control characters, lone surrogates, U+FFFE and U+FFFF) are removed first; there is no CDATA.
 */
export function escapeXml(text: string): string {
  let out = "";
  // Iterating by code point yields a lone surrogate as its own unit, which isXmlChar rejects.
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === undefined || !isXmlChar(cp)) continue;
    out += ENTITIES[ch] ?? ch;
  }
  return out;
}
