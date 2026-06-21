const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");
const net = require("net");

let relaySocket;

// Start the server when the app is ready
function startServer() {
    try {
        // Pass the app path to the server so it can find assets
        const appPath = app.getAppPath();
        process.env.APP_PATH = appPath;
        
        // Require the server module - this starts it automatically
        require("./server.js");
        
        // Give server time to start, then connect
        setTimeout(() => {
            connectToRelay();
        }, 1000);
    } catch (err) {
        console.error("Failed to start server:", err);
    }
}

function connectToRelay() {
    relaySocket = net.createConnection({
        host: "127.0.0.1",
        port: 3001
    });

    relaySocket.on("connect", () => {
        console.log("✓ Main process connected to relay for emitting events");
    });

    relaySocket.on("error", (err) => {
        console.log("Relay emit connection error:", err.message);
    });
}

function createMainWindow() {
    const appPath = app.getAppPath();
    const win = new BrowserWindow({
        width: 900,
        height: 700,
        webPreferences: {
            preload: path.join(appPath, "preload.js")
        }
    });

    win.loadURL("http://localhost:3000/control");
}

ipcMain.handle("get-overlays", () => {

    const overlaysDir = path.join(app.getAppPath(), "overlays");

    if (!fs.existsSync(overlaysDir)) {
        return [];
    }

    const folders = fs.readdirSync(overlaysDir);

    const overlays = [];

    for (const folder of folders) {

        const overlayHtml = path.join(
            overlaysDir,
            folder,
            "overlay.html"
        );

        if (fs.existsSync(overlayHtml)) {
            overlays.push({
                name: folder,
                path: folder
            });
        }
    }

    return overlays;
});

ipcMain.handle("launch-overlay", (event, overlayName) => {

    if (!relaySocket || !relaySocket.writable) {
        console.log("Relay not connected, reconnecting...");
        connectToRelay();
    }

    // Emit overlay change event to the relay server
    const command = JSON.stringify({
        type: "overlay-change",
        overlayName: overlayName
    });

    if (relaySocket && relaySocket.writable) {
        relaySocket.write(command + "\n");
    }

    console.log("🎯 Emitted overlay change:", overlayName);
});

app.whenReady().then(() => {
    startServer();
    createMainWindow();
});

app.on("before-quit", () => {
    if (relaySocket) {
        relaySocket.destroy();
    }
});