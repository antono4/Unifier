#!/usr/bin/env node
/**
 * Unifier — demo event feed.
 *
 * A tiny zero-dependency WebSocket server that streams agent-shaped events,
 * so the "Aliran langsung" panel can be tested without a real agent.
 *
 *   node tools/ws-server.mjs            # ws://localhost:8787/events
 *   node tools/ws-server.mjs 9000       # custom port
 *
 * Then paste the URL into the page's "Aliran langsung" field.
 */

import { createServer } from "node:http";
import { createHash } from "node:crypto";

const PORT = Number(process.argv[2] || 8787);
const PATH = "/events";

/* --- minimal RFC 6455 server (text frames only, no extensions) --- */
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function encode(payload) {
  const data = Buffer.from(payload, "utf8");
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, data]);
}

const server = createServer((req, res) => {
  if (req.url === "/") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(`Unifier demo feed\nWebSocket: ws://localhost:${PORT}${PATH}\n`);
    return;
  }
  res.writeHead(404).end("not found");
});

server.on("upgrade", (req, socket) => {
  if (new URL(req.url, "http://x").pathname !== PATH) {
    socket.destroy();
    return;
  }
  const key = req.headers["sec-websocket-key"];
  const accept = createHash("sha1").update(key + GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  console.log("client connected");
  socket.on("error", () => socket.destroy());
  socket.on("close", () => console.log("client disconnected"));

  const send = (obj) => {
    if (!socket.destroyed) socket.write(encode(JSON.stringify(obj)));
  };

  let n = 0;
  let step = 0;
  const script = [
    { type: "thinking", intensity: 0.6 },
    { type: "tool", name: "browser.search" },
    { type: "token", text: "menyusun jawaban" },
    { type: "token", text: " · memeriksa sumber" },
    { type: "token", text: " · merangkum" },
    { type: "speech", text: "ringkasan siap" },
    { type: "done" },
  ];

  const timer = setInterval(() => {
    if (n++ % 9 === 8) {
      send({ type: "error", message: "rate limit, mencoba ulang" });
      return;
    }
    send(script[step++ % script.length]);
  }, 620);

  socket.on("close", () => clearInterval(timer));
});

server.listen(PORT, () => {
  console.log(`Unifier demo feed on ws://localhost:${PORT}${PATH}`);
});
