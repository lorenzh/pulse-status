/** The part of a DOM node that the patch uses; the browser's nodes and the test fake fit it. */
export interface PatchNode {
  readonly nodeType: number;
  readonly nodeName: string;
  data: string;
  readonly parentNode: PatchNode | null;
  readonly childNodes: ArrayLike<PatchNode>;
  readonly attributes: ArrayLike<{ name: string; value: string }>;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  insertBefore(node: PatchNode, reference: PatchNode | null): PatchNode;
  removeChild(node: PatchNode): PatchNode;
  focus?(options: { preventScroll: boolean }): void;
}

export interface PatchEnv {
  /** Parses html into detached nodes. */
  parse(html: string): PatchNode[];
  activeElement(): PatchNode | null;
}

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

export interface NodeDescriptor {
  key: string | undefined;
  tag: string;
}

export interface ChildPlan {
  /** For each new child, the index of the old child it keeps, or null when it is inserted. */
  matches: (number | null)[];
  /** Old children that no new child keeps. */
  removed: number[];
}

/** Matches by key when the new child has one, else the next unkeyed old child with the same tag. */
export function planChildren(
  oldNodes: readonly NodeDescriptor[],
  newNodes: readonly NodeDescriptor[],
): ChildPlan {
  const byKey = new Map<string, number>();
  const unkeyed: number[] = [];
  oldNodes.forEach((node, index) => {
    if (node.key === undefined) unkeyed.push(index);
    else if (!byKey.has(node.key)) byKey.set(node.key, index);
  });
  const used = new Set<number>();
  let nextUnkeyed = 0;
  const matches = newNodes.map((node): number | null => {
    let found: number | undefined;
    if (node.key === undefined) {
      found = unkeyed[nextUnkeyed];
      if (found !== undefined) nextUnkeyed++;
    } else {
      found = byKey.get(node.key);
    }
    const old = found === undefined ? undefined : oldNodes[found];
    if (found === undefined || old === undefined || old.tag !== node.tag || used.has(found)) {
      return null;
    }
    used.add(found);
    return found;
  });
  const removed = oldNodes.map((_, index) => index).filter((index) => !used.has(index));
  return { matches, removed };
}

export interface AttributeDiff {
  set: [name: string, value: string][];
  remove: string[];
}

/** Attributes in `keep` are left as they are on the old element: the DOM owns their value. */
export function diffAttributes(
  oldAttrs: ReadonlyMap<string, string>,
  newAttrs: ReadonlyMap<string, string>,
  keep: readonly string[] = [],
): AttributeDiff {
  const set: [string, string][] = [];
  for (const [name, value] of newAttrs) {
    if (!keep.includes(name) && oldAttrs.get(name) !== value) set.push([name, value]);
  }
  const remove = [...oldAttrs.keys()].filter((name) => !newAttrs.has(name) && !keep.includes(name));
  return { set, remove };
}

function describe(node: PatchNode): NodeDescriptor {
  const key = node.nodeType === ELEMENT_NODE ? node.getAttribute("data-key") : null;
  return { key: key === null ? undefined : key, tag: node.nodeName };
}

function attributeMap(node: PatchNode): Map<string, string> {
  return new Map(Array.from(node.attributes, (attr) => [attr.name, attr.value]));
}

function isDetails(node: PatchNode): boolean {
  return node.nodeName.toLowerCase() === "details";
}

function syncElement(old: PatchNode, next: PatchNode, env: PatchEnv): void {
  // The open state of a details lives in the DOM, not in the html.
  const keep = isDetails(old) ? ["open"] : [];
  const diff = diffAttributes(attributeMap(old), attributeMap(next), keep);
  for (const [name, value] of diff.set) old.setAttribute(name, value);
  for (const name of diff.remove) old.removeAttribute(name);
  reconcileChildren(old, next, env);
}

function reconcileChildren(parent: PatchNode, next: PatchNode | PatchNode[], env: PatchEnv): void {
  const oldNodes = Array.from(parent.childNodes);
  const newNodes = Array.isArray(next) ? next : Array.from(next.childNodes);
  const plan = planChildren(oldNodes.map(describe), newNodes.map(describe));
  for (const index of plan.removed) {
    const gone = oldNodes[index];
    if (gone !== undefined) parent.removeChild(gone);
  }
  const active = env.activeElement();
  newNodes.forEach((fresh, position) => {
    const matched = plan.matches[position];
    const old = matched === null || matched === undefined ? undefined : oldNodes[matched];
    let node = fresh;
    if (old !== undefined) {
      node = old;
      if (fresh.nodeType === TEXT_NODE) {
        if (old.data !== fresh.data) old.data = fresh.data;
      } else if (fresh.nodeType === ELEMENT_NODE) {
        syncElement(old, fresh, env);
      }
    }
    const current = parent.childNodes[position] ?? null;
    if (current !== node) parent.insertBefore(node, current);
  });
  // Moving a node can drop its focus; restore it.
  if (active !== null && env.activeElement() !== active && active.parentNode !== null) {
    active.focus?.({ preventScroll: true });
  }
}

const lastHtml = new WeakMap<object, string>();

/**
 * Makes the children of `container` equal to `html` with the fewest DOM writes. Nodes with the same
 * `data-key` (or position and tag) are kept, so focus, selection and identity survive. Unchanged
 * html writes nothing.
 */
export function patchHtml(container: PatchNode, html: string, env: PatchEnv): void {
  if (lastHtml.get(container) === html) return;
  reconcileChildren(container, env.parse(html), env);
  lastHtml.set(container, html);
}

interface BrowserTemplate {
  innerHTML: string;
  content: { childNodes: ArrayLike<PatchNode> };
}

interface BrowserDocument {
  createElement(tag: string): BrowserTemplate;
  activeElement: PatchNode | null;
}

function isBrowserDocument(value: unknown): value is BrowserDocument {
  return typeof value === "object" && value !== null && "createElement" in value;
}

class PatchEnvError extends Error {
  override name = "PatchEnvError";
}

/** The environment of a real page; only `client.js` calls it. */
export function browserPatchEnv(): PatchEnv {
  const doc: unknown = Reflect.get(globalThis, "document");
  if (!isBrowserDocument(doc)) throw new PatchEnvError("no document");
  return {
    parse(html: string): PatchNode[] {
      const template = doc.createElement("template");
      template.innerHTML = html;
      return Array.from(template.content.childNodes);
    },
    activeElement: () => doc.activeElement,
  };
}
