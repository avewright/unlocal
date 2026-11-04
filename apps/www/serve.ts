// Local development: `pnpm dev` → http://localhost:4321
import { readFile } from "node:fs/promises";
import { createServer, type RequestListener } from "node:http";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "public");
const PORT = Number(process.env.PORT ?? 4321);
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
};

const serve: RequestListener = async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const rel = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  const file = path.join(ROOT, rel.endsWith("/") ? `${rel}index.html` : rel);
  if (!file.startsWith(ROOT)) return void res.writeHead(403).end();
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    }).end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found\n");
  }
};

// Browsers may resolve localhost to either address. Serve both consistently.
for (const host of ["127.0.0.1", "::1"]) {
  createServer(serve)
    .on("error", (error) => {
      console.error(`Could not start Unlocal on ${host}:${PORT}: ${error.message}`);
      process.exit(1);
    })
    .listen(PORT, host, () => {
      if (host === "::1") console.log(`http://localhost:${PORT}`);
    });
}
