const http = require("http");
const fs = require("fs");
const path = require("path");
const { Server } = require("socket.io");
const { createServerGame } = require("./serverGame");

const PORT = process.env.PORT || 3000;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, content) => {
    if (err) {
      console.error("Read error:", err);
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Server error");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
  });
}

const server = http.createServer((req, res) => {
  if (req.url === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }

  let filePath = path.join(__dirname, "index.html");

  if (req.url === "/clientNet.js") {
    filePath = path.join(__dirname, "clientNet.js");
  } else if (req.url === "/shared.js") {
    filePath = path.join(__dirname, "shared.js");
  } else if (req.url === "/serverGame.js") {
    filePath = path.join(__dirname, "serverGame.js");
  }

  serveFile(res, filePath);
});

const io = new Server(server, {
  cors: { origin: "*" },
});

let waitingPlayer = null;
const matches = new Map();
const socketToRoom = new Map();

function clearWaitingPlayerIfMatches(socketId) {
  if (waitingPlayer && waitingPlayer.id === socketId) {
    waitingPlayer = null;
  }
}

function makeRoomId(a, b) {
  return `match_${a}_${b}`;
}

io.on("connection", (socket) => {
  console.log("Player connected:", socket.id);

  socket.on("pingCheck", (sentAt) => {
    socket.emit("pongCheck", sentAt);
  });

  if (waitingPlayer && waitingPlayer.connected && waitingPlayer.id !== socket.id) {
    const roomId = makeRoomId(waitingPlayer.id, socket.id);

    waitingPlayer.join(roomId);
    socket.join(roomId);

    const game = createServerGame(io, roomId, waitingPlayer.id, socket.id);
    matches.set(roomId, game);
    socketToRoom.set(waitingPlayer.id, roomId);
    socketToRoom.set(socket.id, roomId);

    waitingPlayer.emit("matchFound", game.getMatchFoundPayload(waitingPlayer.id));
    socket.emit("matchFound", game.getMatchFoundPayload(socket.id));

    game.start();
    waitingPlayer = null;
  } else {
    waitingPlayer = socket;
    socket.emit("queueStatus", { message: "Waiting for opponent..." });
  }

  socket.on("inputUpdate", ({ roomId, input }) => {
    const knownRoomId = socketToRoom.get(socket.id);
    if (!knownRoomId) return;
    if (roomId !== knownRoomId) return;

    const game = matches.get(knownRoomId);
    if (!game) return;

    game.setInput(socket.id, input || {});
  });

  socket.on("disconnect", () => {
    console.log("Player disconnected:", socket.id);

    clearWaitingPlayerIfMatches(socket.id);

    const roomId = socketToRoom.get(socket.id);
    if (roomId) {
      const game = matches.get(roomId);
      if (game) {
        game.onDisconnect(socket.id);
        game.stop();
        matches.delete(roomId);
      }

      for (const [otherSocketId, otherRoomId] of socketToRoom.entries()) {
        if (otherRoomId === roomId) {
          socketToRoom.delete(otherSocketId);
        }
      }
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
