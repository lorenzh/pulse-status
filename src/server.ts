import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

export interface ServerOptions {
  /** Base URL of pulse-api. */
  apiUrl: string;
  pollMs: number;
  fetch?: typeof fetch;
}

const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
const srcDir = fileURLToPath(new URL("./", import.meta.url));

// Browser modules compiled from src by stripping types.
const tsModules: Record<string, string> = {
  "/render.js": "render.ts",
  "/poller.js": "poller.ts",
  "/theme.js": "theme.ts",
};

export function createStatusServer(options: ServerOptions): Server {
  const doFetch = options.fetch ?? fetch;
  let apiBase = options.apiUrl;
  while (apiBase.endsWith("/")) apiBase = apiBase.slice(0, -1);

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { allow: "GET, HEAD" }).end();
        return;
      }
      if (url.pathname === "/" || url.pathname === "/index.html") {
        const html = (await readFile(publicDir + "index.html", "utf8")).replace(
          "<body>",
          `<body data-poll-ms="${options.pollMs}">`,
        );
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
        return;
      }
      if (url.pathname === "/client.js") {
        const js = await readFile(publicDir + "client.js", "utf8");
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" }).end(js);
        return;
      }
      const tsFile = tsModules[url.pathname];
      if (tsFile !== undefined) {
        const js = stripTypeScriptTypes(await readFile(srcDir + tsFile, "utf8"));
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" }).end(js);
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        const target = apiBase + url.pathname.slice("/api".length) + url.search;
        let upstream: Response;
        try {
          upstream = await doFetch(target);
        } catch {
          // Any fetch failure means the upstream API is unreachable; answer 502.
          res
            .writeHead(502, { "content-type": "application/json" })
            .end(JSON.stringify({ error: "API unreachable" }));
          return;
        }
        const body = Buffer.from(await upstream.arrayBuffer());
        res
          .writeHead(upstream.status, {
            "content-type": upstream.headers.get("content-type") ?? "application/json",
          })
          .end(body);
        return;
      }
      res
        .writeHead(404, { "content-type": "application/json" })
        .end(JSON.stringify({ error: "not found" }));
    } catch (err) {
      res
        .writeHead(500, { "content-type": "application/json" })
        .end(JSON.stringify({ error: String(err) }));
    }
  });
}
