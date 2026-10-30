import type { PatchEnv, PatchNode } from "./patch.ts";

/** A small DOM for tests: elements and text, with a counter of every write. */
export class FakeNode implements PatchNode {
  parentNode: FakeNode | null = null;
  childNodes: FakeNode[] = [];
  attributes: { name: string; value: string }[] = [];

  readonly nodeType: number;
  readonly nodeName: string;
  data: string;
  private readonly dom: FakeDom;

  constructor(nodeType: number, nodeName: string, data: string, dom: FakeDom) {
    this.nodeType = nodeType;
    this.nodeName = nodeName;
    this.data = data;
    this.dom = dom;
  }

  getAttribute(name: string): string | null {
    return this.attributes.find((attr) => attr.name === name)?.value ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.dom.writes++;
    const found = this.attributes.find((attr) => attr.name === name);
    if (found === undefined) this.attributes.push({ name, value });
    else found.value = value;
  }

  removeAttribute(name: string): void {
    this.dom.writes++;
    this.attributes = this.attributes.filter((attr) => attr.name !== name);
  }

  insertBefore(node: PatchNode, reference: PatchNode | null): PatchNode {
    this.dom.writes++;
    if (!(node instanceof FakeNode)) return node;
    node.parentNode?.childNodes.splice(node.parentNode.childNodes.indexOf(node), 1);
    const at = reference instanceof FakeNode ? this.childNodes.indexOf(reference) : -1;
    this.childNodes.splice(at < 0 ? this.childNodes.length : at, 0, node);
    node.parentNode = this;
    return node;
  }

  removeChild(node: PatchNode): PatchNode {
    this.dom.writes++;
    if (node instanceof FakeNode) {
      this.childNodes.splice(this.childNodes.indexOf(node), 1);
      node.parentNode = null;
      if (this.dom.active === node) this.dom.active = null;
    }
    return node;
  }

  focus(): void {
    this.dom.active = this;
  }
}

export class FakeDom implements PatchEnv {
  writes = 0;
  active: FakeNode | null = null;

  element(tag: string, attrs: Record<string, string> = {}): FakeNode {
    const node = new FakeNode(1, tag.toUpperCase(), "", this);
    node.attributes = Object.entries(attrs).map(([name, value]) => ({ name, value }));
    return node;
  }

  text(data: string): FakeNode {
    return new FakeNode(3, "#text", data, this);
  }

  /** Parses the small html the tests use: tags with quoted attributes, text, no void tags. */
  parse(html: string): FakeNode[] {
    const root = this.element("root");
    let current = root;
    for (const token of tokens(html)) {
      if (token.startsWith("</")) {
        current = current.parentNode ?? root;
      } else if (token.startsWith("<")) {
        const name = token.slice(1).split(/[\s>]/)[0] ?? "span";
        const attrs: Record<string, string> = {};
        for (const m of token.matchAll(/\s([\w-]+)="([^"]*)"/g)) attrs[m[1] ?? ""] = m[2] ?? "";
        const node = this.element(name, attrs);
        node.parentNode = current;
        current.childNodes.push(node);
        current = node;
      } else {
        const node = this.text(token);
        node.parentNode = current;
        current.childNodes.push(node);
      }
    }
    return root.childNodes.map((node) => {
      node.parentNode = null;
      return node;
    });
  }

  activeElement(): PatchNode | null {
    return this.active;
  }
}

/** Splits html into tags and text without a regular expression. */
function tokens(html: string): string[] {
  const out: string[] = [];
  let at = 0;
  while (at < html.length) {
    const end = html[at] === "<" ? html.indexOf(">", at) + 1 : html.indexOf("<", at);
    const stop = end <= at ? html.length : end;
    out.push(html.slice(at, stop));
    at = stop;
  }
  return out;
}
