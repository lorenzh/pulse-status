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
  hasTarget: boolean;
}

const data: StubData = { state: "up", isFailing: false, hasComponents: true, hasTarget: false };

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
  const slo = { target: 99.9, windowDays: 30, availability: 99.95, budgetRemaining: 50 };
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
    ...(data.hasTarget ? { slo } : {}),
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
    ...(data.hasTarget ? { slo } : {}),
    state: data.state,
    uptime: 99.5,
    incidentIds: data.state === "down" ? [1] : [],
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
    "/latency": [
      {
        checkId: "web",
        days: days.map((day, i) => ({
          date: day.date,
          p50Ms: i % 15 === 0 ? null : 80 + (i % 7),
          p95Ms: i % 15 === 0 ? null : 150 + (i % 11) * 5,
          count: i % 15 === 0 ? 0 : 10,
        })),
      },
    ],
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

/** One page layout under test: the server it runs on and what the stub sends. */
interface Layout {
  name: "default" | "shown" | "fallback";
  url: string;
  hasComponents: boolean;
  entryName: string;
}

async function checkStructure(page: Page, layout: Layout): Promise<void> {
  // Bars are decorative: hidden from assistive tech, no tab stop, no per-bar label.
  assert.ok((await page.$$('.bars[aria-hidden="true"]')).length > 0, "decorative bars present");
  assert.equal((await page.$$('[role="group"][data-key="bars"]')).length, 0, "no bars group role");
  assert.equal((await page.$$(".bars [tabindex], .bar[tabindex]")).length, 0, "no bar tab stop");
  assert.equal((await page.$$(".bars [aria-label]")).length, 0, "no per-bar label");
  const summaries = await page.$$eval(".daily-values > summary", (els) =>
    els.map((el) => el.textContent ?? ""),
  );
  assert.ok(summaries.length > 0, "daily-values tables present");
  for (const text of summaries) assert.match(text, /^Daily values, /);
  assert.ok(summaries.includes(`Daily values, ${layout.entryName}`), "a table names the entry");
  const times = await page.$$eval("time[data-exact]", (els) =>
    els.map((el) => el.getAttribute("data-exact") ?? ""),
  );
  assert.ok(times.length > 0, "times present");
  for (const text of times) assert.match(text, / [A-Z][A-Za-z0-9+-]{1,7}$/, `zone in ${text}`);
  assert.match((await page.textContent(".legend")) ?? "", /UTC/);
  await checkLatencyChart(page, layout);
  const span = (await page.textContent(".exact-span")) ?? "";
  assert.match(span, /(EDT|EST|GMT[+-]\d+)/, "span names the zone");
}

async function checkLatencyChart(page: Page, layout: Layout): Promise<void> {
  const summary = (await page.textContent(".latency-summary")) ?? "";
  if (layout.name === "default") {
    assert.match(summary, /^highest member check daily p95, last 7 days \d+ ms/);
    assert.ok(
      (await page.$$('[data-key="component:shop"] .latency-chart')).length === 1,
      "a component latency chart",
    );
  } else {
    assert.match(summary, /^highest daily p95, last 7 days \d+ ms/);
  }
  assert.equal(await page.getAttribute(".latency-svg", "aria-hidden"), "true");
  assert.ok((await page.$$(".latency-svg polyline.lat-p95")).length > 1, "null days leave gaps");
  const sloText = (await page.textContent("body")) ?? "";
  assert.equal(
    sloText.includes("Availability 99.95 % of 99.9 % target, 50 % budget left"),
    data.hasTarget,
    "the SLO sentence shows exactly when a target is set",
  );
  await page.focus(".daily-values summary");
  await page.keyboard.press("Enter");
  assert.equal(await page.getAttribute(".daily-values", "open"), "");
  await polls(3);
  assert.equal(await page.getAttribute(".daily-values", "open"), "", "open survives polls");
  await page.keyboard.press("Enter");
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
    // The one tab stop of an entry is the summary of its daily-values table.
    assert.equal(count, 1, `${key}: 1 tab stop`);
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
  // The component's table summary: going down gives the component its first incident line.
  const summary = '[data-key="component:shop"] > .daily-values > summary';
  await page.focus(summary);
  const focused = `${summary}:focus`;
  await markNode(page, focused);
  await polls(5);
  assert.ok(await hasMarker(page, focused), "same node after five polls");
  data.state = "down";
  await page.waitForFunction(() =>
    /down/.test(document.getElementById("summary")?.textContent ?? ""),
  );
  await page.waitForSelector('[data-key="component:shop"] .incident-count');
  await polls(2);
  assert.ok(await hasMarker(page, focused), "same node after a state change and first incident");
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
  // Native <details>: the table opens without JavaScript and its rows can be read.
  await page.click(".daily-values > summary");
  assert.equal(await page.getAttribute(".daily-values", "open"), "");
  const head = (await page.textContent(".daily-values thead")) ?? "";
  assert.match(head, /Date \(UTC\).*Uptime \(%\).*Highest member check p95 \(ms\).*Results/);
  assert.ok(await page.isVisible(`.daily-values tbody th:text-is("${utcDay(0)}")`), "newest row");
  await context.close();
}

async function checkLayout(browser: Browser, layout: Layout, hasTarget: boolean): Promise<void> {
  data.hasComponents = layout.hasComponents;
  data.hasTarget = hasTarget;
  for (const scheme of ["light", "dark"] as const) {
    for (const width of [360, 1280]) {
      const { context, page } = await open(browser, layout.url, { width, scheme });
      const label = `${scheme} ${width}px ${layout.name} ${hasTarget ? "with" : "without"} target`;
      await checkAxe(page, label);
      await checkStructure(page, layout);
      await context.close();
      console.log(`ok  ${label}`);
    }
  }
}

async function checkBehavior(browser: Browser, layout: Layout): Promise<void> {
  data.hasComponents = layout.hasComponents;
  data.hasTarget = true;
  const { context, page } = await open(browser, layout.url, { width: 1280, scheme: "light" });
  await checkTabStops(page);
  await checkQuietPolls(page);
  await checkFocusSurvivesPolls(page);
  await checkLiveRegions(page);
  await context.close();
  console.log(`ok  behavior ${layout.name}`);
}

async function main(): Promise<void> {
  const api = startApi();
  const apiUrl = await listen(api);
  // Default settings: with components the checks are hidden (hidden mode).
  const hidden = createStatusServer({ apiUrl, pollMs: POLL_MS, cacheMs: 0 });
  const shown = createStatusServer({ apiUrl, pollMs: POLL_MS, cacheMs: 0, showChecks: true });
  const hiddenUrl = await listen(hidden);
  const shownUrl = await listen(shown);
  const layouts: Layout[] = [
    { name: "default", url: hiddenUrl, hasComponents: true, entryName: "Online shop" },
    { name: "shown", url: shownUrl, hasComponents: true, entryName: "Checkout API" },
    // The fallback: the stub sends no components, so the checks are shown.
    { name: "fallback", url: hiddenUrl, hasComponents: false, entryName: "Checkout API" },
  ];
  const browser = await chromium.launch();
  try {
    for (const layout of layouts) {
      for (const hasTarget of [false, true]) await checkLayout(browser, layout, hasTarget);
    }
    const [defaultLayout] = layouts;
    if (defaultLayout === undefined) throw new Error("no default layout");
    await checkBehavior(browser, defaultLayout);
    data.hasComponents = true;
    await checkNoJavaScript(browser, hiddenUrl);
    console.log("ok  no JavaScript");
  } finally {
    await browser.close();
    hidden.close();
    shown.close();
    api.close();
  }
}

await main();
