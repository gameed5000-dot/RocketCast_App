const { contextBridge, ipcMain, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("rocketCast", {
    getOverlays: () => ipcRenderer.invoke("get-overlays"),
    launchOverlay: (overlayName) => ipcRenderer.invoke("launch-overlay", overlayName),
    importOverlayFolder: () => ipcRenderer.invoke("import-overlay-folder"),
    authRegister: (username, password) => ipcRenderer.invoke("auth-register", username, password),
    authLogin: (username, password) => ipcRenderer.invoke("auth-login", username, password),
    authLogout: () => ipcRenderer.invoke("auth-logout"),
    authStatus: () => ipcRenderer.invoke("auth-status"),
    authResetPassword: (username, uniqueCode, newPassword) => ipcRenderer.invoke("auth-reset-password", username, uniqueCode, newPassword),
    getAccountSpreadsheet: () => ipcRenderer.invoke("get-account-spreadsheet"),
    adminUpdateAccountPassword: (username, newPassword) => ipcRenderer.invoke("admin-update-account-password", username, newPassword),
    adminUpdateAccountCode: (username, nextCode) => ipcRenderer.invoke("admin-update-account-code", username, nextCode),
    adminDeleteAccount: (username) => ipcRenderer.invoke("admin-delete-account", username),
    adminExportAccountBackup: () => ipcRenderer.invoke("admin-export-account-backup"),
    checkForUpdates: () => ipcRenderer.invoke("check-for-updates")
});
