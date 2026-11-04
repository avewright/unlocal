import { createServer } from "node:http";

createServer((_req, res) => res.end("ok\n")).listen(Number(process.env.PORT ?? 8080));
