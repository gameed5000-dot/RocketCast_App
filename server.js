const net = require("net");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Get the correct app path - use APP_PATH env var if available (packaged app), otherwise use __dirname (dev)
const appPath = process.env.APP_PATH || __dirname;
console.log("📁 App Path:", appPath);
console.log("📁 Public Dir:", path.join(appPath, "public"));
console.log("📁 Overlays Dir:", path.join(appPath, "overlays"));

// Serve static files from public directory first
app.use(express.static(path.join(appPath, "public")));

/*
|--------------------------------------------------------------------------
| Serve Loader Page at Root
|--------------------------------------------------------------------------
*/

app.get("/", (req, res) => {
    res.sendFile(path.join(appPath, "public", "loader.html"));
});

/*
|--------------------------------------------------------------------------
| Serve Control Panel
|--------------------------------------------------------------------------
*/

app.get("/control", (req, res) => {
    res.sendFile(path.join(appPath, "index.html"));
});

/*
|--------------------------------------------------------------------------
| Serve static assets (CSS, JS) from root for control panel
|--------------------------------------------------------------------------
*/

app.use(express.static(appPath, { 
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
            res.set('Content-Type', 'text/html');
        }
    }
}));

/*
|--------------------------------------------------------------------------
| Automatically serve every overlay in /overlays
|--------------------------------------------------------------------------
*/

const overlaysDir = path.join(appPath, "overlays");

if (fs.existsSync(overlaysDir)) {
    console.log("✓ Overlays directory found");
    const folders = fs.readdirSync(overlaysDir);
    console.log("  Folders:", folders);

    folders.forEach((folder) => {
        const fullPath = path.join(overlaysDir, folder);

        if (!fs.statSync(fullPath).isDirectory()) {
            return;
        }

        const overlayFile = path.join(fullPath, "overlay.html");

        if (!fs.existsSync(overlayFile)) {
            console.log(`Skipping ${folder} (no overlay.html)`);
            return;
        }

        console.log(`  ✓ Found ${folder} overlay at ${fullPath}`);

        // Serve all files in the overlay folder
        app.use(`/${folder}`, express.static(fullPath));

        // Make http://localhost:3000/RLCS load overlay.html
        app.get(`/${folder}`, (req, res) => {
            res.sendFile(overlayFile);
        });

        console.log(
            `Loaded overlay: http://localhost:3000/${folder}`
        );
    });
}

server.listen(3000, () => {
    console.log("🚀 Rocket Cast server running:");
    console.log("📺 http://localhost:3000");
});

/*
|--------------------------------------------------------------------------
| IPC Server for Overlay Changes (from Electron main process)
|--------------------------------------------------------------------------
*/

const ipcServer = net.createServer((socket) => {
    console.log("✓ Electron main process connected");

    socket.on("data", (buffer) => {
        try {
            const command = JSON.parse(buffer.toString().trim());

            if (command.type === "overlay-change") {
                console.log("📡 Received overlay change:", command.overlayName);
                io.emit("overlay-change", {
                    overlayName: command.overlayName
                });
            }
        } catch (err) {
            console.log("IPC parse error:", err.message);
        }
    });

    socket.on("error", (err) => {
        console.log("IPC socket error:", err.message);
    });

    socket.on("close", () => {
        console.log("✗ Electron main process disconnected");
    });
});

ipcServer.listen(3001, "127.0.0.1", () => {
    console.log("🔗 IPC server listening on port 3001");
});

/*
|--------------------------------------------------------------------------
| Overlay Overrides (via Socket.IO)
|--------------------------------------------------------------------------
*/

let lastOverrides = {};

io.on("connection", (socket) => {
    console.log("🌐 Browser connected");

    if (Object.keys(lastOverrides).length) {
        socket.emit("overrides", lastOverrides);
    }

    socket.on("overrides", (data) => {
        lastOverrides = data;
        io.emit("overrides", data);
    });

    socket.on("overlay-change", (data) => {
        console.log("📺 Socket.IO overlay change:", data.overlayName);
        io.emit("overlay-change", data);
    });
});

/*
|--------------------------------------------------------------------------
| Rocket League Relay
|--------------------------------------------------------------------------
*/

const rlReconnectMs = Number(process.env.RL_RECONNECT_MS || 2000);
const rlEndpointsEnv = process.env.RL_ENDPOINTS;
const defaultRlEndpoints = [
    { host: "127.0.0.1", port: 49123 },
    { host: "localhost", port: 49123 },
    { host: "127.0.0.1", port: 49122 },
    { host: "localhost", port: 49122 }
];
const rlEndpoints = rlEndpointsEnv
    ? rlEndpointsEnv
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => {
            const [host, portRaw] = entry.split(":");
            const port = Number(portRaw);

            if (!host || !Number.isInteger(port) || port <= 0) {
                return null;
            }

            return { host, port };
        })
        .filter(Boolean)
    : defaultRlEndpoints;
let rlSocket = null;
let rlReconnectTimer = null;
let rlEndpointIndex = 0;

function parseAndEmitState(raw) {
    try {
        const packet = JSON.parse(raw);

        if (typeof packet.Data === "string") {
            packet.Data = JSON.parse(packet.Data);
        }

        io.emit("state", packet);
    } catch {
        // Ignore malformed or partial payloads.
    }
}

function scheduleRocketLeagueReconnect() {
    if (rlReconnectTimer) {
        return;
    }

    rlReconnectTimer = setTimeout(() => {
        rlReconnectTimer = null;
        connectToRocketLeague();
    }, rlReconnectMs);
}

function connectToRocketLeague() {
    if (rlSocket && !rlSocket.destroyed) {
        return;
    }

    if (!rlEndpoints.length) {
        console.log("🎮 No Rocket League API endpoints configured");
        scheduleRocketLeagueReconnect();
        return;
    }

    let dataBuffer = "";
    const endpoint = rlEndpoints[rlEndpointIndex];

    rlSocket = net.createConnection({
        host: endpoint.host,
        port: endpoint.port
    });

    rlSocket.on("connect", () => {
        console.log(`🎮 Connected to Rocket League at ${endpoint.host}:${endpoint.port}`);
    });

    rlSocket.on("data", (buffer) => {
        dataBuffer += buffer.toString();

        // Process line-delimited JSON if available.
        let newlineIndex = dataBuffer.indexOf("\n");
        while (newlineIndex !== -1) {
            const line = dataBuffer.slice(0, newlineIndex).trim();
            dataBuffer = dataBuffer.slice(newlineIndex + 1);

            if (line) {
                parseAndEmitState(line);
            }

            newlineIndex = dataBuffer.indexOf("\n");
        }

        // Some relays send single complete JSON packets without newlines.
        const trimmed = dataBuffer.trim();
        if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
            parseAndEmitState(trimmed);
            dataBuffer = "";
        }
    });

    rlSocket.on("error", (err) => {
        console.log(`🎮 Rocket League Error (${endpoint.host}:${endpoint.port}):`, err.message);
        rlEndpointIndex = (rlEndpointIndex + 1) % rlEndpoints.length;
        scheduleRocketLeagueReconnect();
    });

    rlSocket.on("close", () => {
        console.log(`🎮 Rocket League connection closed (${endpoint.host}:${endpoint.port})`);
        rlSocket = null;
        scheduleRocketLeagueReconnect();
    });
}

connectToRocketLeague();