// Disposable integration fixture only. Never run with production state or data.
const http = require("node:http"),
  https = require("node:https");
const c = require("../lib/core.cjs");
const s = c.state("/state"),
  r = s.readers[0];
https
  .createServer(
    {
      key: c.read("/state/certificates/rails/key.pem"),
      cert: c.read("/state/certificates/rails/cert.pem"),
    },
    (req, res) => {
      if (req.headers.authorization !== "Bearer " + s.secrets.reservations) {
        res.writeHead(401);
        res.end();
        return;
      }
      if (req.url !== "/api/internal/reader_reservations/sync") {
        res.writeHead(404);
        res.end();
        return;
      }
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const input = JSON.parse(body);
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            serverTime: Date.now(),
            results: input.operations.map(() => ({ outcome: "accepted" })),
          }),
        );
      });
    },
  )
  .listen(9444, "0.0.0.0");
http
  .createServer((req, res) => {
    if (
      req.headers.authorization !==
      "Basic " +
        Buffer.from(r.webUsername + ":" + r.webPassword).toString("base64")
    ) {
      res.writeHead(401);
      res.end();
      return;
    }
    let size = 0;
    req.on("data", (chunk) => (size += chunk.length));
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          fixture: true,
          bytes: size,
          host: req.headers.host,
          referer: req.headers.referer,
        }),
      );
    });
  })
  .listen(80, "0.0.0.0");
