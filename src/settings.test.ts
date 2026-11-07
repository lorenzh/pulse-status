import { test } from "bun:test";
import assert from "node:assert/strict";
import { StartupError } from "@lorenzh/pulse-kit";
import { readSettings } from "./settings.ts";
import { startFromSettings } from "./start.ts";

test("defaults apply for an empty environment", () => {
  assert.deepEqual(readSettings({}), {
    port: 8080,
    apiUrl: "http://localhost:3000",
    pollMs: 5000,
    themeFile: undefined,
    name: undefined,
    logo: undefined,
    publicUrl: undefined,
    hideDetails: true,
    showChecks: false,
    showLatency: true,
    showSlos: true,
    env: {},
    settingsFile: undefined,
    apiToken: undefined,
    settingsPollMs: 15000,
    cacheMs: 2000,
    upstreamTimeoutMs: 4000,
    subscriptions: undefined,
  });
});

test("env page settings: a set value is recorded, also false; empty is unset", () => {
  assert.deepEqual(
    readSettings({
      PULSE_STATUS_NAME: " Acme ",
      PULSE_STATUS_LOGO: "https://cdn.example/l.svg",
      PULSE_STATUS_SHOW_CHECKS: "false",
      PULSE_STATUS_SHOW_LATENCY: "0",
      PULSE_STATUS_SHOW_SLOS: "true",
      PULSE_STATUS_HIDE_DETAILS: "1",
    }).env,
    {
      name: "Acme",
      logo: "https://cdn.example/l.svg",
      showChecks: false,
      showLatency: false,
      showSlos: true,
      hideDetails: true,
    },
  );
  const blank = readSettings({
    PULSE_STATUS_NAME: " ",
    PULSE_STATUS_SHOW_CHECKS: "",
    PULSE_STATUS_SHOW_LATENCY: "  ",
    PULSE_STATUS_SETTINGS_FILE: "",
  });
  assert.deepEqual(blank.env, {});
  assert.equal(blank.settingsFile, undefined);
  assert.equal(
    readSettings({ PULSE_STATUS_SETTINGS_FILE: "/etc/s.json" }).settingsFile,
    "/etc/s.json",
  );
});

test("PULSE_STATUS_SETTINGS_POLL_MS: default 15000, at least 1000", () => {
  assert.equal(readSettings({ PULSE_STATUS_SETTINGS_POLL_MS: "1000" }).settingsPollMs, 1000);
  assert.throws(
    () => readSettings({ PULSE_STATUS_SETTINGS_POLL_MS: "999" }),
    /^StartupError: PULSE_STATUS_SETTINGS_POLL_MS: must be an integer from 1000 to /,
  );
});

test("api token: from the env or its file; errors never hold the token", () => {
  const token = "s3cret-token-value";
  const readFile = (path: string): string => {
    if (path === "/run/token") return `${token}\n`;
    if (path === "/run/empty") return " \n";
    throw Object.assign(new Error(`EACCES ${token}`), { code: "EACCES" });
  };
  assert.equal(readSettings({ PULSE_STATUS_API_TOKEN: token }).apiToken, token);
  assert.equal(
    readSettings({ PULSE_STATUS_API_TOKEN_FILE: "/run/token" }, { readFile }).apiToken,
    token,
  );
  // An empty file variable is not set, as the bench passes it.
  assert.equal(
    readSettings({ PULSE_STATUS_API_TOKEN_FILE: " ", PULSE_STATUS_API_TOKEN: token }).apiToken,
    token,
  );
  const failures: [Record<string, string>, string][] = [
    [
      { PULSE_STATUS_API_TOKEN: token, PULSE_STATUS_API_TOKEN_FILE: "/run/token" },
      "PULSE_STATUS_API_TOKEN and PULSE_STATUS_API_TOKEN_FILE cannot both be set",
    ],
    [
      { PULSE_STATUS_API_TOKEN_FILE: "/run/empty" },
      "PULSE_STATUS_API_TOKEN_FILE=/run/empty: file is empty",
    ],
    [
      { PULSE_STATUS_API_TOKEN_FILE: "/run/locked" },
      "PULSE_STATUS_API_TOKEN_FILE=/run/locked: cannot read (EACCES)",
    ],
  ];
  for (const [env, message] of failures) {
    assert.throws(
      () => readSettings(env, { readFile }),
      (err: unknown) =>
        err instanceof StartupError && err.message === message && !err.message.includes(token),
      message,
    );
  }
});

test("PULSE_STATUS_HIDE_DETAILS: empty hides details; true, false, 1 and 0 are accepted", () => {
  const read = (v: string): boolean => readSettings({ PULSE_STATUS_HIDE_DETAILS: v }).hideDetails;
  assert.equal(read(""), true);
  assert.equal(read("true"), true);
  assert.equal(read("1"), true);
  assert.equal(read("false"), false);
  assert.equal(read("0"), false);
});

test("PULSE_STATUS_HIDE_DETAILS: any other value is a StartupError", () => {
  for (const bad of ["yes", "TRUE", "no"]) {
    assert.throws(
      () => readSettings({ PULSE_STATUS_HIDE_DETAILS: bad }),
      (err: unknown) =>
        err instanceof StartupError &&
        err.message === "PULSE_STATUS_HIDE_DETAILS: must be true, false, 1 or 0",
      bad,
    );
  }
});

test("millisecond settings: value, bound and invalid input", () => {
  assert.equal(readSettings({ POLL_MS: "1000" }).pollMs, 1000);
  assert.equal(readSettings({ PULSE_STATUS_CACHE_MS: "0" }).cacheMs, 0);
  for (const bad of ["abc", "-1", "1.5", "999"]) {
    assert.throws(() => readSettings({ POLL_MS: bad }), /^StartupError: POLL_MS: must be/, bad);
  }
  assert.throws(
    () => readSettings({ POLL_MS: "999" }),
    /POLL_MS: must be an integer from 1000 to 2147483647$/,
  );
});

test("timer settings: POLL_MS and the upstream timeout fit a timer", () => {
  assert.throws(
    () => readSettings({ POLL_MS: "2592000000" }),
    /^StartupError: POLL_MS: must be an integer from 1000 to 2147483647$/,
  );
  assert.equal(readSettings({ POLL_MS: "2147483647" }).pollMs, 2147483647);
  const timeout = (v: string): number =>
    readSettings({ PULSE_STATUS_UPSTREAM_TIMEOUT_MS: v }).upstreamTimeoutMs;
  assert.equal(timeout("2147481647"), 2147481647);
  for (const bad of ["2147481648", "2147483647"]) {
    assert.throws(
      () => timeout(bad),
      /^StartupError: PULSE_STATUS_UPSTREAM_TIMEOUT_MS: must be an integer from 1 to 2147481647$/,
      bad,
    );
  }
});

test("PULSE_STATUS_CACHE_MS is not a timer and accepts large values", () => {
  assert.equal(readSettings({ PULSE_STATUS_CACHE_MS: "3000000000" }).cacheMs, 3000000000);
});

test("PORT: range is 0 to 65535", () => {
  assert.equal(readSettings({ PORT: "0" }).port, 0);
  assert.throws(() => readSettings({ PORT: "65536" }), /PORT: must be an integer from 0 to 65535/);
  assert.throws(() => readSettings({ PORT: "abc" }), /PORT:/);
});

test("PULSE_API_URL: invalid values are rejected without being echoed", () => {
  assert.throws(
    () => readSettings({ PULSE_API_URL: "not-a-url-secret" }),
    (err: unknown) =>
      err instanceof StartupError &&
      err.message === "PULSE_API_URL is not a valid URL" &&
      !err.message.includes("secret"),
  );
});

test("PULSE_STATUS_PUBLIC_URL: unset or empty is off; trailing slash is removed", () => {
  const read = (v: string): string | undefined =>
    readSettings({ PULSE_STATUS_PUBLIC_URL: v }).publicUrl;
  assert.equal(read(""), undefined);
  assert.equal(read("https://status.example.com/"), "https://status.example.com");
  assert.equal(read("http://h.example:8080/pulse/"), "http://h.example:8080/pulse");
});

test("PULSE_STATUS_PUBLIC_URL: rejects other schemes, userinfo, query, fragment and junk", () => {
  for (const bad of [
    "ftp://x.example",
    "javascript:alert(1)",
    "https://u:p@x.example",
    "https://x.example/?a=1",
    "https://x.example/?",
    "https://x.example/#f",
    "https://x.example#",
    "not a url",
  ]) {
    assert.throws(
      () => readSettings({ PULSE_STATUS_PUBLIC_URL: bad }),
      /PULSE_STATUS_PUBLIC_URL: must be an http\(s\) URL without credentials, query or fragment$/,
      bad,
    );
  }
});

test("PULSE_STATUS_SHOW_CHECKS: default and empty are false; true, false, 1 and 0 are accepted", () => {
  const read = (v: string): boolean => readSettings({ PULSE_STATUS_SHOW_CHECKS: v }).showChecks;
  assert.equal(readSettings({}).showChecks, false);
  assert.equal(read(""), false);
  assert.equal(read("true"), true);
  assert.equal(read("1"), true);
  assert.equal(read("false"), false);
  assert.equal(read("0"), false);
});

test("PULSE_STATUS_SHOW_CHECKS: any other value stops the start", () => {
  assert.throws(
    () => readSettings({ PULSE_STATUS_SHOW_CHECKS: "yes" }),
    (err) => err instanceof StartupError && err.message.includes("PULSE_STATUS_SHOW_CHECKS"),
  );
});

const SUBSCRIPTIONS_ON = {
  PULSE_STATUS_SUBSCRIPTIONS_URL: `${"http"}://notify.invalid:9300`,
  PULSE_STATUS_SUBSCRIPTIONS_TOKEN_FILE: "/run/pulse/status-token",
  PULSE_STATUS_SUBSCRIPTIONS_CONTACT: "privacy@example.com",
  PULSE_STATUS_PUBLIC_URL: "https://status.example.com",
};

const failsNaming = (env: Record<string, string>, setting: string, hidden: string[]): void => {
  assert.throws(
    () => readSettings(env),
    (err: unknown) =>
      err instanceof StartupError &&
      err.setting === setting &&
      err.message.startsWith(`${setting}:`) &&
      hidden.every((part) => !err.message.includes(part)),
  );
};

test("subscriptions: off without the URL, and the contact is then ignored", () => {
  assert.equal(
    readSettings({ PULSE_STATUS_SUBSCRIPTIONS_CONTACT: "javascript:alert(1)" }).subscriptions,
    undefined,
  );
});

test("subscriptions: the URL needs the token file, the contact and the public URL", () => {
  assert.deepEqual(readSettings(SUBSCRIPTIONS_ON).subscriptions, {
    notifyUrl: `${"http"}://notify.invalid:9300`,
    tokenFile: "/run/pulse/status-token",
    contact: { kind: "email", address: "privacy@example.com" },
    origin: "https://status.example.com",
  });
  const without = (name: keyof typeof SUBSCRIPTIONS_ON): Record<string, string> => {
    const env: Record<string, string> = { ...SUBSCRIPTIONS_ON };
    delete env[name];
    return env;
  };
  failsNaming(
    without("PULSE_STATUS_SUBSCRIPTIONS_TOKEN_FILE"),
    "PULSE_STATUS_SUBSCRIPTIONS_TOKEN_FILE",
    [],
  );
  failsNaming(
    without("PULSE_STATUS_SUBSCRIPTIONS_CONTACT"),
    "PULSE_STATUS_SUBSCRIPTIONS_CONTACT",
    [],
  );
  failsNaming(without("PULSE_STATUS_PUBLIC_URL"), "PULSE_STATUS_PUBLIC_URL", []);
});

test("R9: subscriptions need the status page at the root of its origin", () => {
  const origin = (v: string): string | undefined =>
    readSettings({ ...SUBSCRIPTIONS_ON, PULSE_STATUS_PUBLIC_URL: v }).subscriptions?.origin;
  assert.equal(origin("https://status.example.com"), "https://status.example.com");
  assert.equal(origin("https://status.example.com/"), "https://status.example.com");
  for (const prefixed of [
    "https://status.example.com/pulse",
    "https://status.example.com/pulse/",
  ]) {
    assert.throws(
      () => readSettings({ ...SUBSCRIPTIONS_ON, PULSE_STATUS_PUBLIC_URL: prefixed }),
      (err: unknown) =>
        err instanceof StartupError &&
        err.message ===
          "PULSE_STATUS_PUBLIC_URL: must be an origin without a path when subscriptions are on (root hosting)",
      prefixed,
    );
  }
  for (const bad of ["https://u:p@status.example.com", "https://status.example.com/?x=1"]) {
    assert.throws(
      () => readSettings({ ...SUBSCRIPTIONS_ON, PULSE_STATUS_PUBLIC_URL: bad }),
      /PULSE_STATUS_PUBLIC_URL: must be an http\(s\) URL without credentials, query or fragment$/,
      bad,
    );
  }
  assert.equal(
    readSettings({ PULSE_STATUS_PUBLIC_URL: "https://status.example.com/pulse/" }).publicUrl,
    "https://status.example.com/pulse",
  );
});

test("R10 contact: a normalized address or an https URL; a bad value is never echoed", () => {
  const contact = (v: string): unknown =>
    readSettings({ ...SUBSCRIPTIONS_ON, PULSE_STATUS_SUBSCRIPTIONS_CONTACT: v }).subscriptions
      ?.contact;
  assert.deepEqual(contact("Privacy@Example.COM"), {
    kind: "email",
    address: "privacy@example.com",
  });
  assert.deepEqual(contact("https://example.com/privacy"), {
    kind: "url",
    url: "https://example.com/privacy",
  });
  for (const bad of [
    `${"http"}://example.com/privacy`,
    "javascript:alert(1)",
    "mailto:a@example.com",
    "a@example.com, b@example.com",
    `https://example.com/${"p".repeat(493)}`,
    "https://u:p@example.com/",
  ]) {
    failsNaming(
      { ...SUBSCRIPTIONS_ON, PULSE_STATUS_SUBSCRIPTIONS_CONTACT: bad },
      "PULSE_STATUS_SUBSCRIPTIONS_CONTACT",
      [bad, "example.com", "alert"],
    );
  }
  failsNaming(
    { ...SUBSCRIPTIONS_ON, PULSE_STATUS_SUBSCRIPTIONS_CONTACT: "" },
    "PULSE_STATUS_SUBSCRIPTIONS_CONTACT",
    [],
  );
});

test("PULSE_STATUS_SUBSCRIPTIONS_URL: a bad URL is refused without its value", () => {
  failsNaming(
    {
      ...SUBSCRIPTIONS_ON,
      PULSE_STATUS_SUBSCRIPTIONS_URL: `${"http"}://user:secret-pw@notify:9300`,
    },
    "PULSE_STATUS_SUBSCRIPTIONS_URL",
    ["secret-pw"],
  );
});

test("the token file: 31 characters fail without echoing the token", () => {
  const settings = readSettings(SUBSCRIPTIONS_ON);
  const short = "t".repeat(31);
  assert.throws(
    () =>
      startFromSettings(settings, undefined, undefined, {
        readFile: () => new TextEncoder().encode(`${short}\n`),
        exists: () => true,
      }),
    (err: unknown) =>
      err instanceof StartupError &&
      err.message.startsWith("PULSE_STATUS_SUBSCRIPTIONS_TOKEN_FILE:") &&
      !err.message.includes(short),
  );
  const started = startFromSettings(settings, undefined, undefined, {
    readFile: () => new TextEncoder().encode("t".repeat(32)),
    exists: () => true,
  });
  assert.ok(started.server);
});
