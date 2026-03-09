const http = require("http");
const fs = require("fs");
const path = require("path");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  if (req.url === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }

  const filePath = path.join(__dirname, "index.html");

  fs.readFile(filePath, (err, content) => {
    if (err) {
      console.error("Read error:", err);
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Server error");
      return;
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(content);
  });
});

const io = new Server(server, {
  cors: { origin: "*" }
});

let waitingPlayer = null;
const matches = new Map();



function makePlayerState(id, slot) {
  return {
    id,
    slot,
    x: slot === 1 ? 360 : 1840,
    vx: 0,
    vy: 0,
    aim: 0,
    y: 700,
    hp: 3000,
    // Should likely change hp to 6000 or have them set to the same as other character is set on Dev settings
    mana: 10000,
    alive: true
  };
}

io.on("connection", (socket) => {
  console.log("Player connected:", socket.id);

  if (waitingPlayer && waitingPlayer.connected) {
    const roomId = `match_${waitingPlayer.id}_${socket.id}`;
    const p1 = makePlayerState(waitingPlayer.id, 1);
    const p2 = makePlayerState(socket.id, 2);

    matches.set(roomId, {
      roomId,
      players: {
        [waitingPlayer.id]: p1,
        [socket.id]: p2
      }
    });

    waitingPlayer.join(roomId);
    socket.join(roomId);

    waitingPlayer.emit("matchFound", {
      roomId,
      you: p1,
      enemy: p2
    });

    socket.emit("matchFound", {
      roomId,
      you: p2,
      enemy: p1
    });

    waitingPlayer = null;
  } else {
    waitingPlayer = socket;
    socket.emit("queueStatus", { message: "Waiting for opponent..." });
  }

  socket.on("playerUpdate", ({ roomId, state }) => {
    const match = matches.get(roomId);
    if (!match || !match.players[socket.id]) return;

    match.players[socket.id] = {
      ...match.players[socket.id],
      ...state
    };

    socket.to(roomId).emit("enemyUpdate", match.players[socket.id]);
  });

  socket.on("disconnect", () => {
    console.log("Player disconnected:", socket.id);

    if (waitingPlayer && waitingPlayer.id === socket.id) {
      waitingPlayer = null;
    }

    for (const [roomId, match] of matches.entries()) {
      if (match.players[socket.id]) {
        socket.to(roomId).emit("opponentLeft");
        matches.delete(roomId);
      }
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
