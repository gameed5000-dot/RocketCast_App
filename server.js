const net = require("net");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const WebSocket = require("ws");
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

const bundledOverlaysDir = path.join(appPath, "overlays");
const customOverlaysDir = path.join(
    process.env.USER_DATA_PATH || path.join(appPath, ".userData"),
    "overlays"
);

fs.mkdirSync(customOverlaysDir, { recursive: true });

let overlayRegistry = new Map();

function listOverlaysFromDirectory(baseDir, source) {
    if (!fs.existsSync(baseDir)) {
        return [];
    }

    const folders = fs.readdirSync(baseDir);
    const overlays = [];

    folders.forEach((folder) => {
        const fullPath = path.join(baseDir, folder);

        if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isDirectory()) {
            return;
        }

        const overlayFile = path.join(fullPath, "overlay.html");
        if (!fs.existsSync(overlayFile)) {
            return;
        }

        overlays.push({
            name: folder,
            path: folder,
            source,
            directory: fullPath
        });
    });

    return overlays;
}

function listAllOverlays() {
    const bundled = listOverlaysFromDirectory(bundledOverlaysDir, "bundled");
    const custom = listOverlaysFromDirectory(customOverlaysDir, "custom");

    const usedPaths = new Set();
    const merged = [];

    bundled
        .sort((a, b) => a.name.localeCompare(b.name))
        .forEach((overlay) => {
            usedPaths.add(overlay.path);
            merged.push(overlay);
        });

    custom
        .sort((a, b) => a.name.localeCompare(b.name))
        .forEach((overlay) => {
            let uniquePath = overlay.path;
            let suffix = 2;

            while (usedPaths.has(uniquePath)) {
                uniquePath = `${overlay.path}-${suffix}`;
                suffix += 1;
            }

            usedPaths.add(uniquePath);
            merged.push({
                ...overlay,
                path: uniquePath
            });
        });

    return merged;
}

function refreshOverlayRegistry() {
    overlayRegistry = new Map();

    listAllOverlays().forEach((overlay) => {
        overlayRegistry.set(overlay.path, overlay);
    });

    console.log("✓ Overlay library refreshed:", Array.from(overlayRegistry.keys()));
}

refreshOverlayRegistry();

app.get("/api/overlays", (req, res) => {
    const overlays = Array.from(overlayRegistry.values()).map((overlay) => ({
        name: overlay.name,
        path: overlay.path,
        source: overlay.source
    }));

    res.json(overlays);
});

app.use((req, res, next) => {
    const requestPath = decodeURIComponent(req.path || "");
    const pathParts = requestPath.split("/").filter(Boolean);

    if (!pathParts.length) {
        next();
        return;
    }

    const overlayName = pathParts[0];
    const overlay = overlayRegistry.get(overlayName);

    if (!overlay) {
        next();
        return;
    }

    const overlayRoot = overlay.directory;

    if (pathParts.length === 1) {
        if (!requestPath.endsWith("/")) {
            res.redirect(302, `${requestPath}/`);
            return;
        }

        res.sendFile(path.join(overlayRoot, "overlay.html"));
        return;
    }

    const targetPath = path.join(overlayRoot, ...pathParts.slice(1));
    const relative = path.relative(overlayRoot, targetPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
        res.status(400).send("Invalid path");
        return;
    }

    if (!fs.existsSync(targetPath)) {
        next();
        return;
    }

    res.sendFile(targetPath);
});

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

    let pendingBuffer = "";

    socket.on("data", (buffer) => {
        pendingBuffer += buffer.toString();
        const messages = pendingBuffer.split("\n");
        pendingBuffer = messages.pop() || "";

        messages.forEach((rawMessage) => {
            const trimmed = rawMessage.trim();
            if (!trimmed) {
                return;
            }

            try {
                const command = JSON.parse(trimmed);

                if (command.type === "overlay-change") {
                    console.log("📡 Received overlay change:", command.overlayName);
                    io.emit("overlay-change", {
                        overlayName: command.overlayName
                    });
                    return;
                }

                if (command.type === "overlay-library-updated") {
                    refreshOverlayRegistry();
                    io.emit("overlays-updated", {
                        overlays: Array.from(overlayRegistry.values()).map((overlay) => ({
                            name: overlay.name,
                            path: overlay.path,
                            source: overlay.source
                        }))
                    });
                }
            } catch (err) {
                console.log("IPC parse error:", err.message);
            }
        });
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
let lastRlStatus = {
    connected: false,
    endpoint: null,
    transport: null,
    lastError: null,
    lastEvent: null,
    lastPacketKeys: []
};

io.on("connection", (socket) => {
    console.log("🌐 Browser connected");

    if (Object.keys(lastOverrides).length) {
        socket.emit("overrides", lastOverrides);
    }

    socket.emit("rl-status", lastRlStatus);

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
    "tcp://127.0.0.1:49123",
    "tcp://localhost:49123",
    "tcp://127.0.0.1:49122",
    "tcp://localhost:49122",
    "ws://127.0.0.1:49122",
    "ws://localhost:49122",
    "ws://127.0.0.1:49123",
    "ws://localhost:49123"
];
const rlEndpointStrings = rlEndpointsEnv
    ? rlEndpointsEnv.split(",").map((entry) => entry.trim()).filter(Boolean)
    : defaultRlEndpoints;
const rlEndpoints = rlEndpointStrings
    .map((entry) => {
        let urlText = entry;
        if (!entry.includes("://")) {
            urlText = `tcp://${entry}`;
        }

        try {
            const url = new URL(urlText);
            const protocol = url.protocol.replace(":", "");
            const port = Number(url.port);

            if (!["tcp", "ws", "wss"].includes(protocol) || !url.hostname || !Number.isInteger(port)) {
                return null;
            }

            return {
                protocol,
                host: url.hostname,
                port,
                href: `${protocol}://${url.hostname}:${port}`
            };
        } catch {
            return null;
        }
    })
    .filter(Boolean);

let rlConnection = null;
let rlReconnectTimer = null;
let rlEndpointIndex = 0;
let rlPacketShapeLogged = false;

function updateRocketLeagueStatus(patch) {
    lastRlStatus = {
        ...lastRlStatus,
        ...patch
    };

    io.emit("rl-status", lastRlStatus);
}

function extractJsonObjects(bufferText) {
    const chunks = [];
    let depth = 0;
    let inString = false;
    let isEscaped = false;
    let objectStart = -1;

    for (let index = 0; index < bufferText.length; index += 1) {
        const char = bufferText[index];

        if (inString) {
            if (isEscaped) {
                isEscaped = false;
            } else if (char === "\\") {
                isEscaped = true;
            } else if (char === '"') {
                inString = false;
            }
            continue;
        }

        if (char === '"') {
            inString = true;
            continue;
        }

        if (char === "{") {
            if (depth === 0) {
                objectStart = index;
            }
            depth += 1;
            continue;
        }

        if (char === "}") {
            if (depth === 0) {
                continue;
            }

            depth -= 1;
            if (depth === 0 && objectStart !== -1) {
                chunks.push(bufferText.slice(objectStart, index + 1));
                objectStart = -1;
            }
        }
    }

    const remainder = depth > 0 && objectStart !== -1
        ? bufferText.slice(objectStart)
        : "";

    return {
        chunks,
        remainder
    };
}

function normalizePacket(packet) {
    if (!packet || typeof packet !== "object") {
        return null;
    }

    if (packet.Event || packet.event) {
        if (typeof packet.Data === "string") {
            try {
                packet.Data = JSON.parse(packet.Data);
            } catch {
                // Keep original Data if it isn't JSON.
            }
        }

        return packet;
    }

    if (packet.data && typeof packet.data === "object") {
        return {
            Event: packet.type || packet.event || "UpdateState",
            Data: packet.data
        };
    }

    // Raw game-state payloads are wrapped so the UI path stays consistent.
    return {
        Event: "UpdateState",
        Data: packet
    };
}

function tryEmitPacket(raw) {
    let parsed;

    if (typeof raw === "string") {
        const trimmed = raw.trim();
        if (!trimmed) {
            return;
        }

        try {
            parsed = JSON.parse(trimmed);
        } catch {
            return;
        }
    } else {
        parsed = raw;
    }

    const normalized = normalizePacket(parsed);
    if (normalized) {
        if (!rlPacketShapeLogged) {
            rlPacketShapeLogged = true;
            console.log("🎮 First Rocket League packet keys:", Object.keys(normalized.Data || normalized).join(", "));
        }

        updateRocketLeagueStatus({
            connected: true,
            lastError: null,
            lastEvent: normalized.Event || normalized.event || "UpdateState",
            lastPacketKeys: Object.keys(normalized.Data || normalized)
        });
        io.emit("state", normalized);
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

function cleanupRocketLeagueConnection() {
    if (!rlConnection) {
        return;
    }

    if (typeof rlConnection.destroy === "function") {
        rlConnection.destroy();
    } else if (typeof rlConnection.close === "function") {
        rlConnection.close();
    }

    rlConnection = null;
}

function connectViaTcp(endpoint) {
    let dataBuffer = "";
    const socket = net.createConnection({ host: endpoint.host, port: endpoint.port });

    socket.on("connect", () => {
        console.log(`🎮 Connected to Rocket League via ${endpoint.href}`);
        updateRocketLeagueStatus({
            connected: true,
            endpoint: endpoint.href,
            transport: "tcp",
            lastError: null
        });
    });

    socket.on("data", (buffer) => {
        dataBuffer += buffer.toString();

        const extracted = extractJsonObjects(dataBuffer);
        extracted.chunks.forEach((chunk) => {
            tryEmitPacket(chunk);
        });
        dataBuffer = extracted.remainder;
    });

    socket.on("error", (err) => {
        console.log(`🎮 Rocket League TCP error (${endpoint.href}):`, err.message);
        updateRocketLeagueStatus({
            connected: false,
            endpoint: endpoint.href,
            transport: "tcp",
            lastError: err.message
        });
    });

    socket.on("close", () => {
        console.log(`🎮 Rocket League TCP connection closed (${endpoint.href})`);
        if (rlConnection === socket) {
            updateRocketLeagueStatus({
                connected: false,
                endpoint: endpoint.href,
                transport: "tcp"
            });
            rlConnection = null;
            rlEndpointIndex = (rlEndpointIndex + 1) % rlEndpoints.length;
            scheduleRocketLeagueReconnect();
        }
    });

    rlConnection = socket;
}

function connectViaWebSocket(endpoint) {
    const ws = new WebSocket(endpoint.href);

    ws.on("open", () => {
        console.log(`🎮 Connected to Rocket League via ${endpoint.href}`);
        updateRocketLeagueStatus({
            connected: true,
            endpoint: endpoint.href,
            transport: endpoint.protocol,
            lastError: null
        });
    });

    ws.on("message", (message) => {
        const payload = Buffer.isBuffer(message) ? message.toString("utf8") : String(message);
        tryEmitPacket(payload);
    });

    ws.on("error", (err) => {
        console.log(`🎮 Rocket League WebSocket error (${endpoint.href}):`, err.message);
        updateRocketLeagueStatus({
            connected: false,
            endpoint: endpoint.href,
            transport: endpoint.protocol,
            lastError: err.message
        });
    });

    ws.on("close", () => {
        console.log(`🎮 Rocket League WebSocket closed (${endpoint.href})`);
        if (rlConnection === ws) {
            updateRocketLeagueStatus({
                connected: false,
                endpoint: endpoint.href,
                transport: endpoint.protocol
            });
            rlConnection = null;
            rlEndpointIndex = (rlEndpointIndex + 1) % rlEndpoints.length;
            scheduleRocketLeagueReconnect();
        }
    });

    rlConnection = ws;
}

function connectToRocketLeague() {
    if (rlConnection) {
        return;
    }

    if (!rlEndpoints.length) {
        console.log("🎮 No Rocket League API endpoints configured");
        updateRocketLeagueStatus({
            connected: false,
            endpoint: null,
            transport: null,
            lastError: "No Rocket League API endpoints configured"
        });
        scheduleRocketLeagueReconnect();
        return;
    }

    cleanupRocketLeagueConnection();
    const endpoint = rlEndpoints[rlEndpointIndex];

    if (endpoint.protocol === "tcp") {
        connectViaTcp(endpoint);
        return;
    }

    connectViaWebSocket(endpoint);
}

connectToRocketLeague();