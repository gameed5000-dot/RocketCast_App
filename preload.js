const { contextBridge, ipcMain, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("rocketCast", {
    getOverlays: () => ipcRenderer.invoke("get-overlays"),
    launchOverlay: (overlayName) => ipcRenderer.invoke("launch-overlay", overlayName)
});
