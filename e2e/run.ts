import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import AxeBuilder from "@axe-core/playwright";
import { WIRE_VERSION, WIRE_VERSION_HEADER } from "@lorenzh/pulse-contract";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { createStatusServer } from "../src/server.ts";

// Accessibility checks of the status page in Chromium. Not part of `bun test`: run `bun run check:a11y`.

const POLL_MS = 200;
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

interface StubData {
  state: "up" | "down";
  isFailing: boolean;
  hasComponents: boolean;
}

const data: StubData = { state: "up", isFailing: false, hasComponents: true };

function utcDay(offset: number): string {
  return new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
}

const days = Array.from({ length: 90 }, (_, i) => ({
  date: utcDay(89 - i),
  uptime: i % 10 === 0 ? 97 : 100,
  results: 10,
}));

// Fixed, so an unchanged poll sends identical data.
const NOW = Date.now();

function body(path: string): unknown {
  const now = NOW;
  const check = {
    id: "web",
    name: "Checkout API",
    type: "http",
    url: "https://example.test/",
    intervalMs: 1000,
    state: data.state,
    consecutiveDown: data.state === "down" ? 3 : 0,
    lastResultAt: now - 60_000,
    lastReason: data.state === "down" ? "HTTP 500" : null,
    locations: [],
  };
  const incident = {
    id: 1,
    checkId: "web",
    openedAt: now - 3_600_000,
    resolvedAt: null,
    reason: "HTTP 500",
  };
  const component = {
    id: "shop",
    name: "Online shop",
    checkIds: ["web"],
    state: data.state,
    uptime: 99.5,
    incidentIds: [],
  };
  const routes: Record<string, unknown> = {
    "/checks": [check],
    "/components": data.hasComponents ? [component] : [],
    "/components/uptime": data.hasComponents ? [{ componentId: "shop", uptime: 99.5, days }] : [],
    "/incidents?status=open": data.state === "down" ? [incident] : [],
    "/incidents?status=resolved": [],
    "/maintenance": [
      { checkId: "web", start: now + 3_600_000, end: now + 7_200_000, note: "Planned upgrade" },
    ],
    "/manual-incidents": [],
    "/uptime": [{ checkId: "web", uptime: 99.5, days }],
  };
  return routes[path];
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function startApi(): Server {
  return createServer((req, res) => {
    const payload = data.isFailing ? undefined : body(req.url ?? "");
    if (payload === undefined) {
      res.writeHead(500, { "content-type": "application/json" }).end("{}");
      return;
    }
    res
      .writeHead(200, {
        "content-type": "application/json",
        [WIRE_VERSION_HEADER]: String(WIRE_VERSION),
      })
      .end(JSON.stringify(payload));
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const polls = (count: number): Promise<void> => sleep(POLL_MS * count + 150);

async function open(
  browser: Browser,
  url: string,
  options: { width: number; scheme: "light" | "dark"; isJs?: boolean },
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: { width: options.width, height: 900 },
    colorScheme: options.scheme,
    timezoneId: "America/New_York",
    javaScriptEnabled: options.isJs ?? true,
  });
  const page = await context.newPage();
  await page.goto(url);
  if (options.isJs !== false) {
    await page.evaluate((scheme) => {
      document.documentElement.dataset.theme = scheme;
    }, options.scheme);
    await page.waitForSelector(".bars");
    await polls(2);
  }
  return { context, page };
}

async function checkAxe(page: Page, label: string): Promise<void> {
  const result = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  const summary = result.violations.map((v) => `${v.id}: ${v.nodes.length}`);
  assert.deepEqual(summary, [], `axe violations (${label})`);
}

async function checkStructure(page: Page, entryName: string): Promise<void> {
  const groups = await page.$$eval('[role="group"][data-key="bars"]', (els) =>
    els.map((el) => el.getAttribute("aria-label") ?? ""),
  );
  assert.ok(groups.length > 0, "bars groups present");
  for (const name of groups) assert.match(name, /, 90-day uptime /);
  assert.ok(
    groups.some((name) => name.includes(entryName)),
    "group names the entry",
  );
  const times = await page.$$eval("time[data-exact]", (els) =>
    els.map((el) => el.getAttribute("data-exact") ?? ""),
  );
  assert.ok(times.length > 0, "times present");
  for (const text of times) assert.match(text, / [A-Z][A-Za-z0-9+-]{1,7}$/, `zone in ${text}`);
  const dayLabels = await page.$$eval(".bar", (els) =>
    els.map((el) => el.getAttribute("aria-label")),
  );
  for (const label of dayLabels) assert.match(label ?? "", / UTC: /);
  assert.match((await page.textContent(".legend")) ?? "", /UTC/);
  const span = (await page.textContent(".exact-span")) ?? "";
  assert.match(span, /(EDT|EST|GMT[+-]\d+)/, "span names the zone");
}

async function countTabStops(page: Page): Promise<Map<string, number>> {
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
  });
  const stops = new Map<string, number>();
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press("Tab");
    const key = await page.evaluate(() => {
      const active = document.activeElement;
      if (active === null || active === document.body) return undefined;
      return active.closest("li.check, li.component")?.getAttribute("data-key") ?? "";
    });
    // Focus left the page content: the end of the tab order.
    if (key === undefined) break;
    if (key !== "") stops.set(key, (stops.get(key) ?? 0) + 1);
  }
  return stops;
}

async function checkTabStops(page: Page): Promise<void> {
  const stops = await countTabStops(page);
  assert.ok(stops.size > 0, "entries are reachable by Tab");
  for (const [key, count] of stops) {
    assert.ok(count <= 3, `${key}: at most 3 tab stops, got ${count}`);
    assert.equal(count, 1, `${key}: one tab stop`);
  }
}

async function markNode(page: Page, selector: string): Promise<void> {
  await page.$eval(selector, (el) => {
    (el as unknown as Record<string, unknown>).marker = "kept";
  });
}

async function hasMarker(page: Page, selector: string): Promise<boolean> {
  return page.$eval(selector, (el) => (el as unknown as Record<string, unknown>).marker === "kept");
}

async function checkFocusSurvivesPolls(page: Page): Promise<void> {
  const group =
    '[data-key="check:web"] [data-key="bars"], [data-key="component:shop"] [data-key="bars"]';
  const bar = `${group.split(", ").join(" .bar[tabindex='0'], ")} .bar[tabindex='0']`;
  await page.focus(bar);
  const dayKey = await page.evaluate(() => document.activeElement?.getAttribute("data-key") ?? "");
  assert.match(dayKey, /^day:/);
  const focused = `[data-key="${dayKey}"]:focus`;
  await markNode(page, focused);
  await polls(5);
  assert.ok(await hasMarker(page, focused), "same node after five polls");
  data.state = "down";
  await page.waitForFunction(() =>
    /down/.test(document.getElementById("summary")?.textContent ?? ""),
  );
  await polls(2);
  assert.ok(await hasMarker(page, focused), "same node after a state change");
  data.state = "up";
  await page.waitForFunction(() =>
    /operational/.test(document.getElementById("summary")?.textContent ?? ""),
  );
}

async function checkQuietPolls(page: Page): Promise<void> {
  await page.evaluate(() => {
    const seen: number[] = [];
    (window as unknown as { mutations: number[] }).mutations = seen;
    const observer = new MutationObserver((records) => seen.push(records.length));
    // "Last updated" (#updated) changes on every poll by design, so it is not observed.
    for (const id of [
      "banner",
      "summary",
      "manual",
      "checks",
      "incidents",
      "resolved",
      "maintenance",
    ]) {
      const element = document.getElementById(id);
      if (element === null) continue;
      observer.observe(element, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
    }
  });
  await polls(5);
  const count = await page.evaluate(
    () => (window as unknown as { mutations: number[] }).mutations.length,
  );
  assert.equal(count, 0, "an unchanged poll makes no DOM mutation");
}

async function checkLiveRegions(page: Page): Promise<void> {
  await markNode(page, "#live");
  await markNode(page, "#alert");
  const before = (await page.textContent("#live")) ?? "";
  await polls(10);
  assert.equal(await page.textContent("#live"), before, "live text stable over ten polls");
  data.state = "down";
  await page.waitForFunction(() => /down/.test(document.getElementById("live")?.textContent ?? ""));
  assert.match((await page.textContent("#live")) ?? "", /down/);
  data.state = "up";
  await polls(3);
  data.isFailing = true;
  await page.waitForFunction(() => (document.getElementById("alert")?.textContent ?? "") !== "");
  data.isFailing = false;
  await page.waitForFunction(() => (document.getElementById("alert")?.textContent ?? "") === "");
  assert.ok(await hasMarker(page, "#live"), "#live is never re-created");
  assert.ok(await hasMarker(page, "#alert"), "#alert is never re-created");
}

async function checkNoJavaScript(browser: Browser, url: string): Promise<void> {
  const { context, page } = await open(browser, url, { width: 1280, scheme: "light", isJs: false });
  const text = (await page.textContent("body")) ?? "";
  for (const expected of [
    "Online shop",
    "Planned upgrade",
    "does not refresh without JavaScript",
  ]) {
    assert.ok(text.includes(expected), `no-JS page shows ${expected}`);
  }
  assert.match(text, /Rendered .* UTC/);
  await context.close();
}

async function checkMatrix(browser: Browser, url: string): Promise<void> {
  for (const hasComponents of [true, false]) {
    data.hasComponents = hasComponents;
    for (const scheme of ["light", "dark"] as const) {
      for (const width of [360, 1280]) {
        const { context, page } = await open(browser, url, { width, scheme });
        const label = `${scheme} ${width}px ${hasComponents ? "components" : "checks"}`;
        await checkAxe(page, label);
        await checkStructure(page, hasComponents ? "Online shop" : "Checkout API");
        await context.close();
        console.log(`ok  ${label}`);
      }
    }
  }
}

async function checkBehavior(browser: Browser, url: string): Promise<void> {
  data.hasComponents = true;
  const { context, page } = await open(browser, url, { width: 1280, scheme: "light" });
  await checkTabStops(page);
  await checkQuietPolls(page);
  await checkFocusSurvivesPolls(page);
  await checkLiveRegions(page);
  await context.close();
  console.log("ok  behavior");
}

async function main(): Promise<void> {
  const api = startApi();
  const apiUrl = await listen(api);
  const status = createStatusServer({ apiUrl, pollMs: POLL_MS, cacheMs: 0, hideDetails: false });
  const url = await listen(status);
  const browser = await chromium.launch();
  try {
    await checkMatrix(browser, url);
    await checkBehavior(browser, url);
    data.hasComponents = true;
    await checkNoJavaScript(browser, url);
    console.log("ok  no JavaScript");
  } finally {
    await browser.close();
    status.close();
    api.close();
  }
}

await main();
