import { test } from "bun:test";
import assert from "node:assert/strict";
import type { StatusSettings } from "@lorenzh/pulse-contract";
import {
  buildReport,
  type EffectiveSettings,
  EMPTY_FILE_LAYER,
  type EnvLayer,
  type FileLayer,
  readInitialLocalFiles,
  readLocalFiles,
  resolveSettings,
} from "./runtime-settings.ts";
import { loadDefaultTheme } from "./theme-config.ts";

const defaultTheme = loadDefaultTheme();

function resolve(
  parts: { env?: EnvLayer; file?: StatusSettings; database?: StatusSettings } = {},
): EffectiveSettings {
  return resolveSettings({
    env: parts.env ?? {},
    file: { settings: parts.file ?? {}, themeVia: "settings file" },
    database: parts.database ?? {},
    defaultTheme,
  });
}

/** A fake file system: path to text, a missing path throws ENOENT. */
function files(entries: Record<string, string | Uint8Array>): (path: string) => Uint8Array {
  return (path) => {
    const body = entries[path];
    if (body === undefined) throw Object.assign(new Error("gone"), { code: "ENOENT" });
    return typeof body === "string" ? new TextEncoder().encode(body) : body;
  };
}

test("absent settings give today's defaults", () => {
  const s = resolve();
  assert.equal(s.name, undefined);
  assert.equal(s.logo, null);
  assert.deepEqual(s.componentOrder, []);
  assert.equal(s.showChecks, false);
  assert.equal(s.showLatency, true);
  assert.equal(s.showSlos, true);
  assert.equal(s.hideDetails, true);
  assert.deepEqual(s.locked, []);
  assert.match(s.css, /--accent:#/);
  assert.equal(
    s.csp,
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
});

interface Case {
  field: string;
  /** The env value of the field, when the env can set it. */
  env?: [EnvLayer, string];
  local: StatusSettings;
  database: StatusSettings;
  read: (s: EffectiveSettings) => unknown;
  localValue: unknown;
  databaseValue: unknown;
  defaultValue: unknown;
}

const cases: Case[] = [
  {
    field: "name",
    env: [{ name: "Local" }, "PULSE_STATUS_NAME"],
    local: { name: "Local" },
    database: { name: "Acme" },
    read: (s) => s.name,
    localValue: "Local",
    databaseValue: "Acme",
    defaultValue: undefined,
  },
  {
    field: "logoUrl",
    local: { logoUrl: "https://file.example/l.svg" },
    database: { logoUrl: "https://db.example/l.svg" },
    read: (s) => s.logo?.src,
    localValue: "https://file.example/l.svg",
    databaseValue: "https://db.example/l.svg",
    defaultValue: undefined,
  },
  {
    field: "theme.light.accent",
    local: { theme: { light: { accent: "#112233" } } },
    database: { theme: { light: { accent: "#445566" } } },
    read: (s) => /:root\{[^}]*--accent:(#[0-9a-f]+);/.exec(s.css)?.[1],
    localValue: "#112233",
    databaseValue: "#445566",
    defaultValue: defaultTheme.light.accent,
  },
  {
    field: "theme.dark.bg",
    local: { theme: { dark: { bg: "#010101" } } },
    database: { theme: { dark: { bg: "#020202" } } },
    read: (s) => /data-theme="dark"\]\{[^}]*--bg:(#[0-9a-f]+);/.exec(s.css)?.[1],
    localValue: "#010101",
    databaseValue: "#020202",
    defaultValue: defaultTheme.dark.bg,
  },
  {
    field: "theme.font-mono",
    local: { theme: { "font-mono": "Local Mono" } },
    database: { theme: { "font-mono": "Db Mono" } },
    read: (s) => /--font-mono:([^;]+);/.exec(s.css)?.[1],
    localValue: "Local Mono",
    databaseValue: "Db Mono",
    defaultValue: defaultTheme.fonts["font-mono"],
  },
  {
    field: "theme.radius-md",
    local: { theme: { "radius-md": "3px" } },
    database: { theme: { "radius-md": "9px" } },
    read: (s) => /--radius-md:([^;]+);/.exec(s.css)?.[1],
    localValue: "3px",
    databaseValue: "9px",
    defaultValue: defaultTheme.radii["radius-md"],
  },
  {
    field: "componentOrder",
    local: { componentOrder: ["b", "a"] },
    database: { componentOrder: ["a"] },
    read: (s) => s.componentOrder,
    localValue: ["b", "a"],
    databaseValue: ["a"],
    defaultValue: [],
  },
];

for (const [flag, variable, fallback] of [
  ["showChecks", "PULSE_STATUS_SHOW_CHECKS", false],
  ["showLatency", "PULSE_STATUS_SHOW_LATENCY", true],
  ["showSlos", "PULSE_STATUS_SHOW_SLOS", true],
  ["hideDetails", "PULSE_STATUS_HIDE_DETAILS", true],
] as const) {
  // Both directions: the local value is the default, the database value is its opposite, and back.
  for (const local of [fallback, !fallback]) {
    cases.push({
      field: flag,
      env: [{ [flag]: local }, variable],
      local: { [flag]: local },
      database: { [flag]: !local },
      read: (s) => s[flag],
      localValue: local,
      databaseValue: !local,
      defaultValue: fallback,
    });
  }
}

for (const c of cases) {
  test(`${c.field} ${JSON.stringify(c.localValue)}: env > file > database > default`, () => {
    if (c.env !== undefined) {
      const [env, via] = c.env;
      const s = resolve({ env, file: c.local, database: c.database });
      assert.deepEqual(c.read(s), c.localValue);
      assert.deepEqual(s.locked, [{ field: c.field, source: "env", via, value: c.localValue }]);
    }
    const fromFile = resolve({ file: c.local, database: c.database });
    assert.deepEqual(c.read(fromFile), c.localValue);
    assert.deepEqual(fromFile.locked, [
      { field: c.field, source: "file", via: "settings file", value: c.localValue },
    ]);
    // The file key removed ({}): the database value applies and nothing is locked.
    const fromDatabase = resolve({ file: {}, database: c.database });
    assert.deepEqual(c.read(fromDatabase), c.databaseValue);
    assert.deepEqual(fromDatabase.locked, []);
    // The database key cleared: the default applies.
    assert.deepEqual(c.read(resolve({ database: {} })), c.defaultValue);
  });
}

test("PULSE_STATUS_SHOW_CHECKS=false, equal to the default, still wins over the database", () => {
  const s = resolve({ env: { showChecks: false }, database: { showChecks: true } });
  assert.equal(s.showChecks, false);
  assert.deepEqual(s.locked, [
    { field: "showChecks", source: "env", via: "PULSE_STATUS_SHOW_CHECKS", value: false },
  ]);
});

test("theme tokens merge per token: file accent wins, database bg stays", () => {
  const s = resolveSettings({
    env: {},
    file: { settings: { theme: { light: { accent: "#112233" } } }, themeVia: "theme file" },
    database: { theme: { light: { accent: "#445566", bg: "#ffffff" } } },
    defaultTheme,
  });
  assert.match(s.css, /^:root\{[^}]*--bg:#ffffff;/);
  assert.match(s.css, /^:root\{[^}]*--accent:#112233;/);
  assert.deepEqual(s.locked, [
    { field: "theme.light.accent", source: "file", via: "theme file", value: "#112233" },
  ]);
});

test("a logoUrl sets the CSP img-src origin; an env logo file keeps its path out of the lock", () => {
  const remote = resolve({ database: { logoUrl: "https://cdn.example:8443/a/logo.svg" } });
  assert.match(remote.csp, /img-src 'self' data: https:\/\/cdn\.example:8443;/);
  const local = resolve({
    env: { logo: { src: "/logo", file: "/srv/logo.svg", type: "image/svg+xml" } },
    database: { logoUrl: "https://cdn.example/logo.svg" },
  });
  assert.equal(local.logo?.src, "/logo");
  assert.deepEqual(local.locked, [{ field: "logoUrl", source: "env", via: "PULSE_STATUS_LOGO" }]);
});

test("fingerprint: 16 hex, stable for equal input, changes with the effective settings", () => {
  const a = resolve({ database: { name: "Acme", showChecks: true } });
  const b = resolve({ database: { showChecks: true, name: "Acme" } });
  assert.match(a.fingerprint, /^[0-9a-f]{16}$/);
  assert.equal(a.fingerprint, b.fingerprint);
  // The same effective value from another layer is the same page.
  assert.equal(resolve({ file: { name: "Acme", showChecks: true } }).fingerprint, a.fingerprint);
  for (const other of [
    resolve({ database: { name: "Acme" } }),
    resolve({ database: { name: "Acme2", showChecks: true } }),
    resolve({ database: { name: "Acme", showChecks: true, theme: { "radius-sm": "1px" } } }),
    resolve({ database: { name: "Acme", showChecks: true, componentOrder: ["x"] } }),
  ]) {
    assert.notEqual(other.fingerprint, a.fingerprint);
  }
});

test("reset: the file rewritten as {} brings back the database, then the default", () => {
  const read = files({ "/s.json": '{"name":"Local"}' });
  const local = readInitialLocalFiles({ settingsFile: "/s.json", themeFile: undefined }, read);
  assert.equal(resolve({ file: local.settings, database: { name: "Acme" } }).name, "Local");
  const empty = readLocalFiles(
    { settingsFile: "/s.json", themeFile: undefined },
    files({ "/s.json": "{}" }),
  );
  assert.ok(empty.ok);
  assert.equal(resolve({ file: empty.value.settings, database: { name: "Acme" } }).name, "Acme");
  assert.equal(resolve({ file: empty.value.settings }).name, undefined);
});

test("a deleted settings file is rejected with ENOENT, not read as {}", () => {
  const read = readLocalFiles({ settingsFile: "/s.json", themeFile: undefined }, files({}));
  assert.deepEqual(read, { ok: false, reason: "settings file: cannot read: ENOENT" });
});

test("settings file refusals: contract rules, size, JSON and theme conflict", () => {
  const paths = { settingsFile: "/s.json", themeFile: undefined };
  const cases: [string | Uint8Array, string][] = [
    [
      JSON.stringify({ theme: { "radius-sm": `${"1".repeat(31)}px` } }),
      "settings file: settings.theme.radius-sm: must be at most 32 characters",
    ],
    [
      JSON.stringify({ componentOrder: ["Upper"] }),
      "settings file: settings.componentOrder[0]: must match ^[a-z0-9][a-z0-9._-]*$",
    ],
    [
      JSON.stringify({ componentOrder: ["a".repeat(65)] }),
      "settings file: settings.componentOrder[0]: must be at most 64 characters",
    ],
    [
      JSON.stringify({ logoUrl: "https://example.com/lögo.svg" }),
      "settings file: settings.logoUrl: must be an https url of printable ASCII characters without userinfo",
    ],
    [
      JSON.stringify({ logoUrl: "https://user:pw@example.com/l.svg" }),
      "settings file: settings.logoUrl: must be an https url of printable ASCII characters without userinfo",
    ],
    ["{nope", "settings file: invalid JSON"],
    [new Uint8Array(1_048_577).fill(32), "settings file: must be at most 1048576 bytes"],
  ];
  for (const [body, reason] of cases) {
    assert.deepEqual(readLocalFiles(paths, files({ "/s.json": body })), { ok: false, reason });
  }
  // Exactly at the bound the file is read.
  const padded = new Uint8Array(1_048_576).fill(32);
  padded.set(new TextEncoder().encode("{}"));
  assert.equal(readLocalFiles(paths, files({ "/s.json": padded })).ok, true);
});

test("the legacy theme file keeps its radius rule; the settings file may not set theme too", () => {
  const radius = `${"1".repeat(31)}px`;
  const legacy = readLocalFiles(
    { settingsFile: undefined, themeFile: "/t.json" },
    files({ "/t.json": JSON.stringify({ "radius-sm": radius }) }),
  );
  assert.ok(legacy.ok);
  assert.deepEqual(legacy.value.settings.theme, { "radius-sm": radius });
  assert.throws(
    () =>
      readInitialLocalFiles(
        { settingsFile: "/s.json", themeFile: "/t.json" },
        files({ "/s.json": '{"theme":{}}', "/t.json": "{}" }),
      ),
    /^StartupError: settings file: theme: cannot be set while PULSE_STATUS_THEME is set$/,
  );
  const both = readLocalFiles(
    { settingsFile: "/s.json", themeFile: "/t.json" },
    files({ "/s.json": '{"name":"Local"}', "/t.json": '{"light":{"bg":"#000"}}' }),
  );
  assert.deepEqual(both, {
    ok: true,
    value: {
      settings: { name: "Local", theme: { light: { bg: "#000" } } },
      themeVia: "theme file",
    },
  });
});

test("a legacy theme token over 2048 bytes of JSON is locked without its value", () => {
  const font = `"${"a".repeat(3000)}"`;
  const file: FileLayer = { settings: { theme: { "font-sans": font } }, themeVia: "theme file" };
  const s = resolveSettings({ env: {}, file, database: {}, defaultTheme });
  assert.deepEqual(s.locked, [{ field: "theme.font-sans", source: "file", via: "theme file" }]);
});

test("the initial read refuses an unusable configured file", () => {
  const paths = { settingsFile: "/s.json", themeFile: undefined };
  assert.throws(
    () => readInitialLocalFiles(paths, files({})),
    /^StartupError: settings file: cannot read: ENOENT$/,
  );
  assert.throws(
    () => readInitialLocalFiles(paths, files({ "/s.json": new Uint8Array(1_048_577) })),
    /^StartupError: settings file: must be at most 1048576 bytes$/,
  );
  assert.deepEqual(
    readInitialLocalFiles({ settingsFile: undefined, themeFile: undefined }, files({})),
    EMPTY_FILE_LAYER,
  );
});

test("the largest valid settings and 60 locks give a report of at most 164224 bytes", () => {
  const id = (i: number): string => `${String(i).padStart(3, "0")}${"a".repeat(61)}`;
  const componentOrder = Array.from({ length: 500 }, (_, i) => id(i));
  const locked = [
    {
      field: "componentOrder",
      source: "file" as const,
      via: "settings file",
      value: componentOrder,
    },
    ...Array.from({ length: 59 }, (_, i) => ({
      field: `theme.light.k${i}`,
      source: "file" as const,
      via: "theme file",
      value: "\u0001".repeat(339),
    })),
  ];
  const report = buildReport({
    at: Number.MAX_SAFE_INTEGER,
    startedAt: Number.MAX_SAFE_INTEGER,
    appliedRevision: `sha256-${"f".repeat(64)}`,
    rejected: { source: "file", reason: "\u0001".repeat(400) },
    locked,
  });
  assert.equal(report.locked.length, 60);
  assert.equal(report.rejected?.reason.length, 300);
  assert.deepEqual(report.locked[0]?.value, componentOrder);
  assert.ok(Buffer.byteLength(JSON.stringify(report)) <= 164_224);
});

test("a report over the limit leaves out the componentOrder value first", () => {
  const big = "x".repeat(300_000);
  const report = buildReport({
    at: 1,
    startedAt: 1,
    appliedRevision: null,
    rejected: null,
    locked: [
      { field: "name", source: "env", via: "PULSE_STATUS_NAME", value: "n" },
      { field: "componentOrder", source: "file", via: "settings file", value: [big] },
      { field: "theme.font-sans", source: "file", via: "theme file", value: big },
    ],
  });
  assert.deepEqual(report.locked, [
    { field: "name", source: "env", via: "PULSE_STATUS_NAME", value: "n" },
    { field: "componentOrder", source: "file", via: "settings file" },
    { field: "theme.font-sans", source: "file", via: "theme file", value: big },
  ]);
});
