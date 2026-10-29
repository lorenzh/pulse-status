import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAtom, type FeedInput } from "./feed.ts";
import { escapeXml } from "./xml.ts";
import { child, parseXml } from "./xml-parser.ts";

const base: FeedInput = {
  publicUrl: "https://status.example.com",
  name: "Acme",
  checks: [
    { id: "web", name: "Web" },
    { id: "api", name: "Ap<i>]]>&" },
  ],
  open: [{ id: 5, checkId: "api", openedAt: 2000000, resolvedAt: null, reason: "<&>" }],
  resolved: [
    { id: 4, checkId: "web", openedAt: 1000000, resolvedAt: 1500000, reason: null },
    { id: 3, checkId: "gone", openedAt: 10, resolvedAt: 20, reason: null },
  ],
};

test("escapeXml: escapes the five characters and drops illegal ones", () => {
  assert.equal(escapeXml(`a&b<c>d"e'f`), "a&amp;b&lt;c&gt;d&quot;e&apos;f");
  assert.equal(escapeXml("a\u0000b\u0001c\ud800d￿e"), "abcde");
  assert.equal(escapeXml("ok \t\n\r 😀"), "ok \t\n\r 😀");
  assert.equal(escapeXml("]]>"), "]]&gt;");
});

test("buildAtom: well-formed feed with entries for listed checks, newest first", () => {
  const feed = parseXml(buildAtom(base));
  assert.equal(feed.name, "feed");
  assert.equal(child(feed, "title").text, "Acme incidents");
  assert.equal(child(feed, "id").text, "https://status.example.com");
  assert.equal(child(feed, "updated").text, "1970-01-01T00:33:20Z");
  const links = feed.children.filter((c) => c.name === "link");
  assert.deepEqual(
    links.map((l) => [l.attrs.rel, l.attrs.href]),
    [
      ["alternate", "https://status.example.com"],
      ["self", "https://status.example.com/feed.atom"],
    ],
  );
  const entries = feed.children.filter((c) => c.name === "entry");
  assert.equal(entries.length, 2);
  const [first, second] = entries;
  if (first === undefined || second === undefined) throw new Error("entries");
  assert.equal(child(first, "title").text, "Ap<i>]]>&: Open");
  assert.equal(child(first, "id").text, "tag:status.example.com,2026:incident-5");
  assert.equal(child(first, "updated").text, "1970-01-01T00:33:20Z");
  assert.equal(child(first, "link").attrs.href, "https://status.example.com");
  assert.equal(child(first, "summary").text, "Opened 1970-01-01T00:33:20Z\nReason: <&>");
  assert.equal(child(second, "title").text, "Web: Resolved");
  assert.equal(child(second, "updated").text, "1970-01-01T00:25:00Z");
  assert.equal(
    child(second, "summary").text,
    "Opened 1970-01-01T00:16:40Z\nResolved 1970-01-01T00:25:00Z",
  );
});

test("buildAtom: empty feed has the epoch as updated; output is deterministic", () => {
  const input = { ...base, open: [], resolved: [] };
  const xml = buildAtom(input);
  assert.equal(child(parseXml(xml), "updated").text, "1970-01-01T00:00:00Z");
  assert.equal(buildAtom(input), xml);
});

test("buildAtom: ties sort by id descending; hostile text and name stay well-formed", () => {
  const xml = buildAtom({
    publicUrl: "https://s.example",
    name: "N<&>\u0000😀",
    checks: [{ id: "a", name: "A\u0000<script>" }],
    open: [
      { id: 1, checkId: "a", openedAt: 5000, resolvedAt: null, reason: "x]]>\u0000😀" },
      { id: 2, checkId: "a", openedAt: 5000, resolvedAt: null },
    ],
    resolved: [],
  });
  const feed = parseXml(xml);
  assert.equal(child(feed, "title").text, "N<&>😀 incidents");
  const ids = feed.children.filter((c) => c.name === "entry").map((e) => child(e, "id").text);
  assert.deepEqual(ids, ["tag:s.example,2026:incident-2", "tag:s.example,2026:incident-1"]);
  assert.ok(!xml.includes("<script>"));
  assert.ok(xml.includes("x]]&gt;😀"));
});
