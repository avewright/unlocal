// Local preview: `pnpm www` → http://localhost:4321
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "public");
const PORT = Number(process.env.PORT ?? 4321);
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const rel = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  const file = path.join(ROOT, rel.endsWith("/") ? `${rel}index.html` : rel);
  if (!file.startsWith(ROOT)) return void res.writeHead(403).end();
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found\n");
  }
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));
