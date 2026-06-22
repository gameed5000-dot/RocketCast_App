const { app, BrowserWindow, ipcMain, dialog, safeStorage } = require("electron");
const fs = require("fs");
const path = require("path");
const net = require("net");
const os = require("os");
const crypto = require("crypto");
const { autoUpdater } = require("electron-updater");
const log = require("electron-log");

let relaySocket;
let currentAccount = null;
let currentAuthToken = "";
const CREDENTIAL_RESET_VERSION = "v1";
const ADMIN_USERNAME = "snorklz";
const AUTH_API_BASE_URL = String(process.env.RC_AUTH_API_BASE_URL || "").trim().replace(/\/+$/g, "");

function getBundledOverlaysDir() {
    return path.join(app.getAppPath(), "overlays");
}

function getCustomOverlaysDir() {
    return path.join(app.getPath("userData"), "overlays");
}

function sanitizeOverlayName(rawName) {
    return String(rawName || "")
        .trim()
        .replace(/[^a-zA-Z0-9-_ ]/g, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
}

function listOverlaysFromDirectory(baseDir, source) {
    if (!fs.existsSync(baseDir)) {
        return [];
    }

    const folders = fs.readdirSync(baseDir);
    const overlays = [];

    for (const folder of folders) {
        const overlayDir = path.join(baseDir, folder);
        const overlayHtml = path.join(overlayDir, "overlay.html");

        if (!fs.statSync(overlayDir).isDirectory() || !fs.existsSync(overlayHtml)) {
            continue;
        }

        overlays.push({
            name: folder,
            path: folder,
            source
        });
    }

    return overlays;
}

function listAllOverlays() {
    const bundled = listOverlaysFromDirectory(getBundledOverlaysDir(), "bundled");
    const custom = listOverlaysFromDirectory(getCustomOverlaysDir(), "custom");

    const usedPaths = new Set();
    const result = [];

    bundled
        .sort((a, b) => a.name.localeCompare(b.name))
        .forEach((overlay) => {
            usedPaths.add(overlay.path);
            result.push(overlay);
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
            result.push({
                ...overlay,
                path: uniquePath
            });
        });

    return result;
}

function notifyOverlayLibraryUpdated() {
    if (!relaySocket || !relaySocket.writable) {
        return;
    }

    relaySocket.write(JSON.stringify({ type: "overlay-library-updated" }) + "\n");
}

function importOverlayDirectory(selectedDir) {
    const overlayFile = path.join(selectedDir, "overlay.html");

    if (!fs.existsSync(overlayFile)) {
        throw new Error("Selected folder must contain overlay.html");
    }

    const customOverlaysDir = getCustomOverlaysDir();
    fs.mkdirSync(customOverlaysDir, { recursive: true });

    const baseName = sanitizeOverlayName(path.basename(selectedDir));
    if (!baseName) {
        throw new Error("Overlay folder name is not valid");
    }

    let targetName = baseName;
    let suffix = 2;

    const bundledOverlayName = listOverlaysFromDirectory(getBundledOverlaysDir(), "bundled")
        .some((overlay) => overlay.name.toLowerCase() === targetName.toLowerCase());

    if (bundledOverlayName) {
        targetName = `${baseName}-custom`;
    }

    while (
        fs.existsSync(path.join(customOverlaysDir, targetName)) ||
        listOverlaysFromDirectory(getBundledOverlaysDir(), "bundled")
            .some((overlay) => overlay.name.toLowerCase() === targetName.toLowerCase())
    ) {
        targetName = `${baseName}-${suffix}`;
        suffix += 1;
    }

    const targetDir = path.join(customOverlaysDir, targetName);
    fs.cpSync(selectedDir, targetDir, { recursive: true });

    return {
        name: targetName,
        path: targetName,
        source: "custom"
    };
}

function getAccountsFilePath() {
    return path.join(app.getPath("userData"), "accounts.json");
}

function loadAccounts() {
    const filePath = getAccountsFilePath();

    if (!fs.existsSync(filePath)) {
        return [];
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function saveAccounts(accounts) {
    const filePath = getAccountsFilePath();
    fs.writeFileSync(filePath, JSON.stringify(accounts, null, 2), "utf8");
}

function sanitizeUsername(rawUsername) {
    return String(rawUsername || "")
        .trim()
        .replace(/[^a-zA-Z0-9._-]/g, "")
        .toLowerCase();
}

function hashPassword(password, salt) {
    return crypto
        .createHash("sha256")
        .update(`${salt}:${password}`)
        .digest("hex");
}

function hashValue(value) {
    return crypto
        .createHash("sha256")
        .update(String(value || ""))
        .digest("hex");
}

function protectSecret(plainText) {
    const text = String(plainText || "");

    if (safeStorage.isEncryptionAvailable()) {
        const encrypted = safeStorage.encryptString(text);
        return `dpapi:${encrypted.toString("base64")}`;
    }

    // Fallback when platform encryption is unavailable.
    return `plain:${Buffer.from(text, "utf8").toString("base64")}`;
}

function unprotectSecret(storedValue) {
    const text = String(storedValue || "");
    if (!text) {
        return "";
    }

    if (text.startsWith("dpapi:")) {
        const raw = Buffer.from(text.slice(6), "base64");
        return safeStorage.decryptString(raw);
    }

    if (text.startsWith("plain:")) {
        return Buffer.from(text.slice(6), "base64").toString("utf8");
    }

    return "";
}

function toAccountPublic(account) {
    return {
        username: account.username,
        createdAt: account.createdAt,
        uniqueCode: account.uniqueCode || ""
    };
}

function isAdminUsername(username) {
    return String(username || "").toLowerCase() === ADMIN_USERNAME;
}

function isCurrentAccountAdmin() {
    return isAdminUsername(currentAccount?.username || "");
}

function generateUniqueCode(existingCodes) {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

    while (true) {
        let code = "";
        for (let index = 0; index < 8; index += 1) {
            code += alphabet[Math.floor(Math.random() * alphabet.length)];
        }

        if (!existingCodes.has(code)) {
            return code;
        }
    }
}

function ensureAccountCodes(accounts) {
    const existingCodes = new Set(
        accounts
            .map((account) => account.uniqueCode)
            .filter(Boolean)
    );

    let changed = false;
    accounts.forEach((account) => {
        if (!account.uniqueCode && account.uniqueCodeProtected) {
            account.uniqueCode = unprotectSecret(account.uniqueCodeProtected);
        }

        if (!account.uniqueCode) {
            account.uniqueCode = generateUniqueCode(existingCodes);
            changed = true;
        }

        if (!account.uniqueCodeProtected) {
            account.uniqueCodeProtected = protectSecret(account.uniqueCode);
            changed = true;
        }

        if (!account.uniqueCodeHash) {
            account.uniqueCodeHash = hashValue(account.uniqueCode);
            changed = true;
        }

        if (!account.deviceId) {
            account.deviceId = getDeviceId();
            changed = true;
        }

        if (!account.hostName) {
            account.hostName = os.hostname();
            changed = true;
        }

        existingCodes.add(account.uniqueCode);
    });

    if (changed) {
        saveAccounts(accounts);
    }

    return accounts;
}

function getDeviceIdPath() {
    return path.join(app.getPath("userData"), "device-id.txt");
}

function getDeviceId() {
    const deviceIdPath = getDeviceIdPath();

    if (fs.existsSync(deviceIdPath)) {
        const existing = String(fs.readFileSync(deviceIdPath, "utf8") || "").trim();
        if (existing) {
            return existing;
        }
    }

    const generated = crypto.randomBytes(6).toString("hex").toUpperCase();
    fs.writeFileSync(deviceIdPath, generated, "utf8");
    return generated;
}

function getAccountsSpreadsheetPath() {
    const configuredPath = String(process.env.ACCOUNT_SPREADSHEET_PATH || "").trim();

    if (configuredPath) {
        return configuredPath;
    }

    return path.join(app.getPath("documents"), "Rocket Cast", "accounts-spreadsheet.csv");
}

function getCredentialResetMarkerPath() {
    return path.join(app.getPath("userData"), `credential-reset-${CREDENTIAL_RESET_VERSION}.flag`);
}

function csvValue(value) {
    const text = String(value ?? "");
    return `"${text.replace(/"/g, '""')}"`;
}

function ensureSpreadsheetHeader(filePath) {
    if (fs.existsSync(filePath)) {
        return;
    }

    const parentDir = path.dirname(filePath);
    if (parentDir && parentDir !== ".") {
        fs.mkdirSync(parentDir, { recursive: true });
    }

    const header = [
        "createdAt",
        "username",
        "password",
        "uniqueCode",
        "deviceId",
        "hostName"
    ].map(csvValue).join(",") + "\n";

    fs.writeFileSync(filePath, header, "utf8");
}

function appendAccountToSpreadsheet({ username, password, uniqueCode }) {
    const accounts = ensureAccountCodes(loadAccounts());
    syncAccountsSpreadsheet(accounts);
    return getAccountsSpreadsheetPath();
}

function syncAccountsSpreadsheet(accounts) {
    const filePath = getAccountsSpreadsheetPath();
    const parentDir = path.dirname(filePath);

    if (parentDir && parentDir !== ".") {
        fs.mkdirSync(parentDir, { recursive: true });
    }

    const header = [
        "createdAt",
        "username",
        "passwordProtected",
        "uniqueCodeProtected",
        "deviceId",
        "hostName"
    ].map(csvValue).join(",");

    const rows = accounts.map((account) => {
        return [
            account.createdAt || "",
            account.username || "",
            account.passwordProtected || "",
            account.uniqueCodeProtected || "",
            account.deviceId || "",
            account.hostName || ""
        ].map(csvValue).join(",");
    });

    fs.writeFileSync(filePath, [header, ...rows].join("\n") + "\n", "utf8");
}

function parseCsvLine(line) {
    const values = [];
    let current = "";
    let inQuotes = false;

    for (let index = 0; index < line.length; index += 1) {
        const char = line[index];

        if (char === '"') {
            const nextChar = line[index + 1];
            if (inQuotes && nextChar === '"') {
                current += '"';
                index += 1;
            } else {
                inQuotes = !inQuotes;
            }
            continue;
        }

        if (char === "," && !inQuotes) {
            values.push(current);
            current = "";
            continue;
        }

        current += char;
    }

    values.push(current);
    return values;
}

function readAccountSpreadsheetRows() {
    const filePath = getAccountsSpreadsheetPath();
    if (!fs.existsSync(filePath)) {
        return {
            filePath,
            headers: ["createdAt", "username", "password", "uniqueCode", "deviceId", "hostName"],
            rows: []
        };
    }

    const raw = fs.readFileSync(filePath, "utf8");
    const lines = raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

    if (!lines.length) {
        return {
            filePath,
            headers: ["createdAt", "username", "password", "uniqueCode", "deviceId", "hostName"],
            rows: []
        };
    }

    const headers = parseCsvLine(lines[0]);
    const rows = lines.slice(1).map((line) => parseCsvLine(line));

    return {
        filePath,
        headers,
        rows
    };
}

function resetStoredCredentialsOnce() {
    const markerPath = getCredentialResetMarkerPath();
    if (fs.existsSync(markerPath)) {
        return;
    }

    saveAccounts([]);
    currentAccount = null;

    fs.writeFileSync(markerPath, new Date().toISOString(), "utf8");
    console.log("Credential reset migration applied.");
}

function getAdminSpreadsheetRows() {
    if (!isCurrentAccountAdmin()) {
        throw new Error("Spreadsheet access denied");
    }

    const accounts = ensureAccountCodes(loadAccounts());
    const headers = ["createdAt", "username", "password", "uniqueCode", "deviceId", "hostName"];
    const rows = accounts.map((account) => {
        const password = account.passwordProtected
            ? unprotectSecret(account.passwordProtected)
            : "";
        const uniqueCode = account.uniqueCodeProtected
            ? unprotectSecret(account.uniqueCodeProtected)
            : account.uniqueCode || "";

        return [
            account.createdAt || "",
            account.username || "",
            password,
            uniqueCode,
            account.deviceId || "(not set)",
            account.hostName || "(not set)"
        ];
    });

    return {
        filePath: getAccountsSpreadsheetPath(),
        headers,
        rows
    };
}

function getAccountsBackupPath() {
    return path.join(app.getPath("documents"), "Rocket Cast", `accounts-backup-${Date.now()}.json`);
}

function isRemoteAuthEnabled() {
    return Boolean(AUTH_API_BASE_URL);
}

async function callRemoteAuthApi(endpoint, options = {}) {
    if (!isRemoteAuthEnabled()) {
        return { ok: false, error: "Remote auth API is not configured" };
    }

    const method = options.method || "GET";
    const body = options.body;
    const timeoutMs = Number(process.env.RC_AUTH_API_TIMEOUT_MS || 15000);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const headers = {
        Accept: "application/json"
    };

    if (currentAuthToken) {
        headers.Authorization = `Bearer ${currentAuthToken}`;
    }

    if (body !== undefined) {
        headers["Content-Type"] = "application/json";
    }

    try {
        const response = await fetch(`${AUTH_API_BASE_URL}${endpoint}`, {
            method,
            headers,
            body: body !== undefined ? JSON.stringify(body) : undefined,
            signal: controller.signal
        });

        let payload = null;
        try {
            payload = await response.json();
        } catch {
            payload = null;
        }

        if (!response.ok || payload?.ok === false) {
            if (response.status === 401) {
                currentAuthToken = "";
                currentAccount = null;
            }

            return {
                ok: false,
                status: response.status,
                error: payload?.error || `Request failed (${response.status})`
            };
        }

        return payload || { ok: true };
    } catch (err) {
        if (err?.name === "AbortError") {
            return { ok: false, error: "Auth API request timed out" };
        }

        return {
            ok: false,
            error: err?.message || "Auth API request failed"
        };
    } finally {
        clearTimeout(timeoutId);
    }
}

// Start the server when the app is ready
function startServer() {
    try {
        // Pass the app path to the server so it can find assets
        const appPath = app.getAppPath();
        process.env.APP_PATH = appPath;
        process.env.USER_DATA_PATH = app.getPath("userData");

        const logPath = path.join(app.getPath("userData"), "rocket-cast-main.log");
        const logStream = fs.createWriteStream(logPath, { flags: "a" });

        for (const method of ["log", "warn", "error"]) {
            const original = console[method].bind(console);
            console[method] = (...args) => {
                const line = args.map((value) => {
                    if (value instanceof Error) {
                        return value.stack || value.message;
                    }

                    if (typeof value === "string") {
                        return value;
                    }

                    try {
                        return JSON.stringify(value);
                    } catch {
                        return String(value);
                    }
                }).join(" ");

                logStream.write(`[${new Date().toISOString()}] [${method}] ${line}\n`);
                original(...args);
            };
        }
        
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

function setupAutoUpdater() {
    if (!app.isPackaged) {
        return;
    }

    autoUpdater.logger = log;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on("checking-for-update", () => {
        console.log("Updater: checking for update");
    });

    autoUpdater.on("update-available", (info) => {
        console.log("Updater: update available", info?.version || "unknown");
    });

    autoUpdater.on("update-not-available", () => {
        console.log("Updater: no update available");
    });

    autoUpdater.on("error", (err) => {
        console.log("Updater error:", err?.message || err);
    });

    autoUpdater.on("update-downloaded", async (info) => {
        const result = await dialog.showMessageBox({
            type: "info",
            buttons: ["Install now", "Later"],
            defaultId: 0,
            cancelId: 1,
            title: "Update ready",
            message: `Rocket Cast ${info?.version || ""} is ready to install.`
        });

        if (result.response === 0) {
            autoUpdater.quitAndInstall();
        }
    });

    autoUpdater.checkForUpdatesAndNotify();
}

ipcMain.handle("check-for-updates", async () => {
    if (!app.isPackaged) {
        return {
            ok: true,
            available: false,
            message: "Update checks are only available in packaged builds"
        };
    }

    try {
        const currentVersion = app.getVersion();
        const result = await autoUpdater.checkForUpdates();
        const updateVersion = result?.updateInfo?.version || "";
        const isUpdateAvailable = Boolean(updateVersion) && updateVersion !== currentVersion;

        if (!isUpdateAvailable) {
            return {
                ok: true,
                available: false,
                version: currentVersion,
                message: "You're on the latest version!"
            };
        }

        const prompt = await dialog.showMessageBox({
            type: "info",
            buttons: ["Update now", "Later"],
            defaultId: 0,
            cancelId: 1,
            title: "Update available",
            message: `Version ${updateVersion} is available.`,
            detail: `You are currently on ${currentVersion}.`
        });

        if (prompt.response === 0) {
            await autoUpdater.downloadUpdate();
            return {
                ok: true,
                available: true,
                version: updateVersion,
                message: `Downloading update ${updateVersion}...`
            };
        }

        return {
            ok: true,
            available: true,
            version: updateVersion,
            message: `Update ${updateVersion} is available (remind me later).`
        };
    } catch (err) {
        return {
            ok: false,
            message: err?.message || "Failed to check for updates"
        };
    }
});

ipcMain.handle("get-overlays", () => {
    return listAllOverlays();
});

ipcMain.handle("import-overlay-folder", async () => {
    const result = await dialog.showOpenDialog({
        title: "Select an overlay folder",
        properties: ["openDirectory"]
    });

    if (result.canceled || !result.filePaths?.length) {
        return { canceled: true };
    }

    try {
        const importedOverlay = importOverlayDirectory(result.filePaths[0]);
        notifyOverlayLibraryUpdated();

        return {
            canceled: false,
            overlay: importedOverlay
        };
    } catch (err) {
        return {
            canceled: false,
            error: err?.message || "Failed to import overlay"
        };
    }
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

ipcMain.handle("auth-register", (event, usernameRaw, passwordRaw) => {
    const username = sanitizeUsername(usernameRaw);
    const password = String(passwordRaw || "");

    if (isRemoteAuthEnabled()) {
        return callRemoteAuthApi("/auth/register", {
            method: "POST",
            body: {
                username,
                password,
                deviceId: getDeviceId(),
                hostName: os.hostname()
            }
        }).then((result) => {
            if (!result?.ok) {
                return result;
            }

            currentAuthToken = String(result.token || "");
            currentAccount = result.account || null;

            return {
                ok: true,
                account: currentAccount,
                sheetSynced: true,
                spreadsheetPath: `${AUTH_API_BASE_URL}/admin/accounts`
            };
        });
    }

    if (username.length < 3) {
        return { ok: false, error: "Username must be at least 3 characters" };
    }

    if (password.length < 6) {
        return { ok: false, error: "Password must be at least 6 characters" };
    }

    const accounts = ensureAccountCodes(loadAccounts());
    const existing = accounts.find((account) => account.username === username);
    if (existing) {
        return { ok: false, error: "Username already exists" };
    }

    const salt = crypto.randomBytes(16).toString("hex");
    const passwordHash = hashPassword(password, salt);
    const account = {
        username,
        salt,
        passwordHash,
        passwordProtected: protectSecret(password),
        uniqueCode: generateUniqueCode(new Set(accounts.map((entry) => entry.uniqueCode).filter(Boolean))),
        uniqueCodeProtected: "",
        uniqueCodeHash: "",
        createdAt: new Date().toISOString()
    };

    account.uniqueCodeProtected = protectSecret(account.uniqueCode);
    account.uniqueCodeHash = hashValue(account.uniqueCode);
    account.deviceId = getDeviceId();
    account.hostName = os.hostname();

    accounts.push(account);
    saveAccounts(accounts);
    syncAccountsSpreadsheet(accounts);
    currentAccount = toAccountPublic(account);

    return {
        ok: true,
        account: currentAccount,
        sheetSynced: true,
        spreadsheetPath: getAccountsSpreadsheetPath()
    };
});

ipcMain.handle("auth-login", async (event, usernameRaw, passwordRaw) => {
    const username = sanitizeUsername(usernameRaw);
    const password = String(passwordRaw || "");

    if (isRemoteAuthEnabled()) {
        const result = await callRemoteAuthApi("/auth/login", {
            method: "POST",
            body: { username, password }
        });

        if (!result?.ok) {
            return result;
        }

        currentAuthToken = String(result.token || "");
        currentAccount = result.account || null;

        return {
            ok: true,
            account: currentAccount
        };
    }

    const accounts = ensureAccountCodes(loadAccounts());

    const account = accounts.find((entry) => entry.username === username);
    if (!account) {
        return { ok: false, error: "Account not found" };
    }

    const attemptedHash = hashPassword(password, account.salt);
    if (attemptedHash !== account.passwordHash) {
        return { ok: false, error: "Invalid password" };
    }

    currentAccount = toAccountPublic(account);

    return {
        ok: true,
        account: currentAccount
    };

});

ipcMain.handle("auth-reset-password", (event, usernameRaw, oldPasswordRaw, newPasswordRaw) => {
    const username = sanitizeUsername(usernameRaw);
    const oldPassword = String(oldPasswordRaw || "");
    const newPassword = String(newPasswordRaw || "");

    if (isRemoteAuthEnabled()) {
        if (!currentAccount?.username) {
            return { ok: false, error: "Sign in first" };
        }

        if (String(currentAccount.username).toLowerCase() !== username) {
            return { ok: false, error: "You can only reset your own password" };
        }

        return callRemoteAuthApi("/auth/reset-password", {
            method: "POST",
            body: {
                oldPassword,
                newPassword
            }
        });
    }

    if (newPassword.length < 6) {
        return { ok: false, error: "New password must be at least 6 characters" };
    }

    const accounts = ensureAccountCodes(loadAccounts());
    const account = accounts.find((entry) => entry.username === username);
    if (!account) {
        return { ok: false, error: "Account not found" };
    }

    const oldPasswordHash = hashPassword(oldPassword, account.salt);
    if (oldPasswordHash !== account.passwordHash) {
        return { ok: false, error: "Old password is incorrect" };
    }

    account.salt = crypto.randomBytes(16).toString("hex");
    account.passwordHash = hashPassword(newPassword, account.salt);
    account.passwordProtected = protectSecret(newPassword);

    saveAccounts(accounts);
    syncAccountsSpreadsheet(accounts);
    return { ok: true };
});

ipcMain.handle("admin-update-account-password", (event, usernameRaw, newPasswordRaw) => {
    if (isRemoteAuthEnabled()) {
        const username = sanitizeUsername(usernameRaw);
        const newPassword = String(newPasswordRaw || "");

        if (!username) {
            return { ok: false, error: "Username is required" };
        }

        return callRemoteAuthApi(`/admin/accounts/${encodeURIComponent(username)}/password`, {
            method: "PATCH",
            body: { newPassword }
        });
    }

    if (!isCurrentAccountAdmin()) {
        return { ok: false, error: "Admin access required" };
    }

    const username = sanitizeUsername(usernameRaw);
    const newPassword = String(newPasswordRaw || "");

    if (newPassword.length < 6) {
        return { ok: false, error: "Password must be at least 6 characters" };
    }

    const accounts = ensureAccountCodes(loadAccounts());
    const account = accounts.find((entry) => entry.username === username);
    if (!account) {
        return { ok: false, error: "Account not found" };
    }

    account.salt = crypto.randomBytes(16).toString("hex");
    account.passwordHash = hashPassword(newPassword, account.salt);
    account.passwordProtected = protectSecret(newPassword);

    saveAccounts(accounts);
    syncAccountsSpreadsheet(accounts);
    return { ok: true };
});

ipcMain.handle("admin-update-account-code", (event, usernameRaw, nextCodeRaw) => {
    if (isRemoteAuthEnabled()) {
        const username = sanitizeUsername(usernameRaw);
        const nextCode = String(nextCodeRaw || "");

        if (!username) {
            return { ok: false, error: "Username is required" };
        }

        return callRemoteAuthApi(`/admin/accounts/${encodeURIComponent(username)}/code`, {
            method: "PATCH",
            body: { nextCode }
        });
    }

    if (!isCurrentAccountAdmin()) {
        return { ok: false, error: "Admin access required" };
    }

    const username = sanitizeUsername(usernameRaw);
    const nextCodeInput = String(nextCodeRaw || "").trim().toUpperCase();
    const accounts = ensureAccountCodes(loadAccounts());
    const account = accounts.find((entry) => entry.username === username);

    if (!account) {
        return { ok: false, error: "Account not found" };
    }

    const existingCodes = new Set(
        accounts
            .filter((entry) => entry.username !== username)
            .map((entry) => entry.uniqueCode)
    );

    let nextCode = nextCodeInput;
    if (!nextCode) {
        nextCode = generateUniqueCode(existingCodes);
    }

    if (nextCode.length < 4) {
        return { ok: false, error: "Code must be at least 4 characters" };
    }

    if (existingCodes.has(nextCode)) {
        return { ok: false, error: "Code already in use" };
    }

    account.uniqueCode = nextCode;
    account.uniqueCodeProtected = protectSecret(nextCode);
    account.uniqueCodeHash = hashValue(nextCode);

    saveAccounts(accounts);
    syncAccountsSpreadsheet(accounts);

    return { ok: true, uniqueCode: nextCode };
});

ipcMain.handle("admin-delete-account", (event, usernameRaw) => {
    if (isRemoteAuthEnabled()) {
        const username = sanitizeUsername(usernameRaw);
        if (!username) {
            return { ok: false, error: "Username is required" };
        }

        return callRemoteAuthApi(`/admin/accounts/${encodeURIComponent(username)}`, {
            method: "DELETE"
        });
    }

    if (!isCurrentAccountAdmin()) {
        return { ok: false, error: "Admin access required" };
    }

    const username = sanitizeUsername(usernameRaw);
    if (!username) {
        return { ok: false, error: "Username is required" };
    }

    if (isAdminUsername(username)) {
        return { ok: false, error: "Cannot delete the Snorklz account" };
    }

    const accounts = ensureAccountCodes(loadAccounts());
    const nextAccounts = accounts.filter((entry) => entry.username !== username);

    if (nextAccounts.length === accounts.length) {
        return { ok: false, error: "Account not found" };
    }

    saveAccounts(nextAccounts);
    syncAccountsSpreadsheet(nextAccounts);
    return { ok: true };
});

ipcMain.handle("admin-export-account-backup", async () => {
    if (isRemoteAuthEnabled()) {
        const spreadsheetResult = await callRemoteAuthApi("/admin/accounts", {
            method: "GET"
        });

        if (!spreadsheetResult?.ok) {
            return spreadsheetResult;
        }

        const headers = Array.isArray(spreadsheetResult.headers) ? spreadsheetResult.headers : [];
        const rows = Array.isArray(spreadsheetResult.rows) ? spreadsheetResult.rows : [];
        const defaultJsonPath = getAccountsBackupPath();
        const defaultCsvPath = path.join(
            path.dirname(defaultJsonPath),
            `accounts-backup-${Date.now()}.csv`
        );

        const result = await dialog.showSaveDialog({
            title: "Export account backup",
            defaultPath: defaultJsonPath,
            filters: [
                { name: "JSON backup", extensions: ["json"] }
            ]
        });

        if (result.canceled || !result.filePath) {
            return { ok: false, canceled: true };
        }

        const jsonPath = result.filePath;
        const csvPath = defaultCsvPath;

        fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
        fs.writeFileSync(jsonPath, JSON.stringify({ headers, rows }, null, 2), "utf8");

        const csvLines = [headers.map(csvValue).join(",")];
        rows.forEach((row) => {
            csvLines.push((Array.isArray(row) ? row : []).map(csvValue).join(","));
        });
        fs.writeFileSync(csvPath, `${csvLines.join("\n")}\n`, "utf8");

        return {
            ok: true,
            jsonPath,
            csvPath
        };
    }

    if (!isCurrentAccountAdmin()) {
        return { ok: false, error: "Admin access required" };
    }

    const accounts = ensureAccountCodes(loadAccounts());
    const defaultJsonPath = getAccountsBackupPath();
    const defaultCsvPath = getAccountsSpreadsheetPath().replace(/\.csv$/i, `-backup-${Date.now()}.csv`);

    const result = await dialog.showSaveDialog({
        title: "Export account backup",
        defaultPath: defaultJsonPath,
        filters: [
            { name: "JSON backup", extensions: ["json"] }
        ]
    });

    if (result.canceled || !result.filePath) {
        return { ok: false, canceled: true };
    }

    const jsonPath = result.filePath;
    const csvPath = defaultCsvPath;

    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(jsonPath, JSON.stringify(accounts, null, 2), "utf8");

    const spreadsheetPath = getAccountsSpreadsheetPath();
    if (fs.existsSync(spreadsheetPath)) {
        fs.copyFileSync(spreadsheetPath, csvPath);
    }

    return {
        ok: true,
        jsonPath,
        csvPath: fs.existsSync(spreadsheetPath) ? csvPath : null
    };
});

ipcMain.handle("auth-logout", () => {
    currentAccount = null;
    currentAuthToken = "";
    return { ok: true };
});

ipcMain.handle("auth-status", async () => {
    if (!isRemoteAuthEnabled()) {
        return {
            ok: true,
            account: currentAccount
        };
    }

    if (!currentAuthToken) {
        currentAccount = null;
        return {
            ok: true,
            account: null
        };
    }

    const result = await callRemoteAuthApi("/auth/me", {
        method: "GET"
    });

    if (!result?.ok) {
        return {
            ok: true,
            account: null
        };
    }

    currentAccount = result.account || null;

    return {
        ok: true,
        account: currentAccount
    };
});

ipcMain.handle("get-account-spreadsheet", async () => {
    if (isRemoteAuthEnabled()) {
        const result = await callRemoteAuthApi("/admin/accounts", {
            method: "GET"
        });

        if (!result?.ok) {
            return result;
        }

        return {
            ok: true,
            filePath: `${AUTH_API_BASE_URL}/admin/accounts`,
            headers: Array.isArray(result.headers) ? result.headers : [],
            rows: Array.isArray(result.rows) ? result.rows : []
        };
    }

    try {
        return {
            ok: true,
            ...getAdminSpreadsheetRows()
        };
    } catch (err) {
        return {
            ok: false,
            error: err?.message || "Failed to read account spreadsheet"
        };
    }
});

app.whenReady().then(() => {
    resetStoredCredentialsOnce();
    startServer();
    createMainWindow();
    setupAutoUpdater();
});

app.on("before-quit", () => {
    if (relaySocket) {
        relaySocket.destroy();
    }
});