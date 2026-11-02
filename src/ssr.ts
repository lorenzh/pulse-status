import { WIRE_VERSION_HEADER } from "@lorenzh/pulse-contract";
import { createPoller, type PollerState } from "./poller.ts";
import type { TimeEnv } from "./render.ts";
import { buildSections } from "./sections.ts";

/** What the page needs from the cached reads of the proxy. */
export interface SsrAnswer {
  status: number;
  body: string;
  wireVersion?: string | undefined;
}

export interface SsrContext {
  read: (path: string) => Promise<SsrAnswer>;
  now: () => number;
  showChecks: boolean;
}

const exactFormat = new Intl.DateTimeFormat("en", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short",
});
const dayFormat = new Intl.DateTimeFormat("en", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});
const clockFormat = new Intl.DateTimeFormat("en", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});
const clockZoneFormat = new Intl.DateTimeFormat("en", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
  timeZoneName: "short",
});

/** Times of the server-rendered page: always UTC, and the text names the zone. */
export function serverTimeEnv(now: number): TimeEnv {
  const dayAndClock = (date: Date): string =>
    `${dayFormat.format(date)}, ${clockFormat.format(date)}`;
  return {
    now,
    formatExact: (epochMs) => exactFormat.format(new Date(epochMs)),
    formatExactSpan: (startMs, endMs) => {
      const start = new Date(startMs);
      const end = new Date(endMs);
      const isSameDay = start.toISOString().slice(0, 10) === end.toISOString().slice(0, 10);
      return {
        start: dayAndClock(start),
        end: isSameDay
          ? clockZoneFormat.format(end)
          : `${dayFormat.format(end)}, ${clockZoneFormat.format(end)}`,
        isSameDay,
      };
    },
  };
}

function answerAsResponse(answer: SsrAnswer): Response {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (answer.wireVersion !== undefined) headers[WIRE_VERSION_HEADER] = answer.wireVersion;
  return new Response(answer.body, { status: answer.status, headers });
}

/** The sections of the page, built from one refresh of the same cached reads the proxy uses. */
export async function renderState(ctx: SsrContext): Promise<Record<string, string>> {
  let state: PollerState | undefined;
  const poller = createPoller({
    fetch: Object.assign(
      async (input: string | Request | URL): Promise<Response> =>
        answerAsResponse(await ctx.read(typeof input === "string" ? input : String(input))),
      { preconnect: () => {} },
    ),
    timer: { setTimeout: () => undefined, clearTimeout: () => {} },
    now: ctx.now,
    pollMs: 1,
    baseUrl: "/api",
    onUpdate: (next) => {
      state = next;
    },
    log: () => {},
  });
  await poller.refresh();
  if (state === undefined) return {};
  const sections = buildSections(state, serverTimeEnv(ctx.now()), undefined, {
    showChecks: ctx.showChecks,
  });
  sections.rendered = renderedNote(ctx.now());
  return sections;
}

function renderedNote(now: number): string {
  const env = serverTimeEnv(now);
  return (
    `<noscript><p class="no-js-note">This page does not refresh without JavaScript. Rendered ` +
    `<time datetime="${new Date(now).toISOString()}">${env.formatExact(now)}</time>.</p></noscript>`
  );
}
