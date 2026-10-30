/** The part of a DOM element that the bar keys use. */
export interface BarNode {
  readonly parentNode: BarNode | null;
  readonly childNodes: ArrayLike<BarNode>;
  readonly nodeType: number;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  focus?(options: { preventScroll: boolean }): void;
}

export interface BarEvent {
  key?: string;
  target: unknown;
  preventDefault?(): void;
}

export interface BarsDocument {
  addEventListener(type: "keydown" | "focusin", listener: (event: BarEvent) => void): void;
}

const ELEMENT_NODE = 1;

export function isBarsGroup(node: BarNode): boolean {
  return node.nodeType === ELEMENT_NODE && node.getAttribute("data-key") === "bars";
}

function isBarNode(node: BarNode): boolean {
  return (
    node.nodeType === ELEMENT_NODE && (node.getAttribute("class") ?? "").split(" ").includes("bar")
  );
}

function barsOf(group: BarNode): BarNode[] {
  return Array.from(group.childNodes).filter(isBarNode);
}

/** Exactly one bar of the group is a tab stop: `bar` gets 0, all others -1. */
export function setBarTabStop(group: BarNode, bar: BarNode): void {
  for (const other of barsOf(group)) other.setAttribute("tabindex", other === bar ? "0" : "-1");
}

/**
 * Repairs the tab stop after the bars changed: one stop stays, else the focused bar keeps it, else
 * the last bar that held it, else the last bar.
 */
export function ensureRovingStop(group: BarNode, active: BarNode | null = null): void {
  const bars = barsOf(group);
  const stops = bars.filter((bar) => bar.getAttribute("tabindex") === "0");
  if (stops.length === 1) return;
  const chosen = stops.find((bar) => bar === active) ?? stops.at(-1) ?? bars.at(-1);
  if (chosen !== undefined) setBarTabStop(group, chosen);
}

/** Target index for a key, or undefined when the key does nothing. Arrows do not wrap. */
export function nextBarIndex(key: string, index: number, count: number): number | undefined {
  switch (key) {
    case "ArrowLeft":
      return Math.max(0, index - 1);
    case "ArrowRight":
      return Math.min(count - 1, index + 1);
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return undefined;
  }
}

function isBarNodeLike(value: unknown): value is BarNode {
  return typeof value === "object" && value !== null && "getAttribute" in value;
}

function groupOf(target: unknown): { bar: BarNode; group: BarNode } | undefined {
  if (!isBarNodeLike(target) || !isBarNode(target)) return undefined;
  const group = target.parentNode;
  return group !== null && isBarsGroup(group) ? { bar: target, group } : undefined;
}

/** Binds the roving keys once on the document. */
export function bindBars(doc: BarsDocument): void {
  doc.addEventListener("focusin", (event) => {
    const found = groupOf(event.target);
    if (found !== undefined) setBarTabStop(found.group, found.bar);
  });
  doc.addEventListener("keydown", (event) => {
    const found = groupOf(event.target);
    if (found === undefined || event.key === undefined) return;
    const bars = barsOf(found.group);
    const next = nextBarIndex(event.key, bars.indexOf(found.bar), bars.length);
    const target = next === undefined ? undefined : bars[next];
    if (target === undefined) return;
    event.preventDefault?.();
    setBarTabStop(found.group, target);
    target.focus?.({ preventScroll: false });
  });
}
