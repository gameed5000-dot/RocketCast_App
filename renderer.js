// Socket.IO Connection - inject script in HTML head if needed
let socket = null;

// Wait for Socket.IO library to be available
function initSocket() {
    if (typeof io === 'undefined') {
        console.log('Socket.IO not loaded yet, retrying...');
        setTimeout(initSocket, 500);
        return;
    }

    socket = io();
    console.log('Socket.IO initialized');

    socket.on('connect', () => {
        console.log('✓ Connected to Rocket Cast relay');
        showToast('Connected to relay');
    });

    socket.on('disconnect', () => {
        console.log('✗ Disconnected from relay');
        showToast('Disconnected from relay', true);
    });

    // Listen for overrides to sync UI
    socket.on('overrides', (data) => {
        if (!data) return;
        
        if (data.blueName) document.getElementById('blue-name').value = data.blueName;
        if (data.orangeName) document.getElementById('orange-name').value = data.orangeName;
        if (data.blueAbbr) document.getElementById('blue-abbr').value = data.blueAbbr;
        if (data.orangeAbbr) document.getElementById('orange-abbr').value = data.orangeAbbr;
        if (data.blueColor) document.getElementById('blue-color').value = data.blueColor;
        if (data.orangeColor) document.getElementById('orange-color').value = data.orangeColor;
        if (data.seriesLen) document.getElementById('series-length').value = data.seriesLen;
        if (data.blueWins !== undefined) document.getElementById('blue-wins').value = data.blueWins;
        if (data.orangeWins !== undefined) document.getElementById('orange-wins').value = data.orangeWins;
        if (data.headerText) document.getElementById('header-text').value = data.headerText;
    });
}

// Initialize socket when document is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSocket);
} else {
    initSocket();
}

// Logo preview handling
document.getElementById('blue-logo-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = (event) => {
            const img = document.getElementById('blue-logo-preview');
            img.innerHTML = `<img src="${event.target.result}" alt="Blue logo">`;
            localStorage.setItem('blueLogo', event.target.result);
            emitOverrides();
        };
        reader.readAsDataURL(file);
    }
});

document.getElementById('orange-logo-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = (event) => {
            const img = document.getElementById('orange-logo-preview');
            img.innerHTML = `<img src="${event.target.result}" alt="Orange logo">`;
            localStorage.setItem('orangeLogo', event.target.result);
            emitOverrides();
        };
        reader.readAsDataURL(file);
    }
});

// Restore logos from localStorage on page load
document.addEventListener('DOMContentLoaded', () => {
    const blueLogo = localStorage.getItem('blueLogo');
    if (blueLogo) {
        document.getElementById('blue-logo-preview').innerHTML = `<img src="${blueLogo}" alt="Blue logo">`;
    }
    const orangeLogo = localStorage.getItem('orangeLogo');
    if (orangeLogo) {
        document.getElementById('orange-logo-preview').innerHTML = `<img src="${orangeLogo}" alt="Orange logo">`;
    }
});

// Auto-generate abbreviations from team names
function generateAbbreviation(teamName) {
    if (!teamName) return '';
    
    // Take first 3 characters and convert to uppercase
    return teamName.substring(0, 3).toUpperCase();
}

// Listen for team name changes and auto-fill abbreviations
document.getElementById('blue-name').addEventListener('input', (e) => {
    const abbr = generateAbbreviation(e.target.value);
    document.getElementById('blue-abbr').value = abbr;
});

document.getElementById('orange-name').addEventListener('input', (e) => {
    const abbr = generateAbbreviation(e.target.value);
    document.getElementById('orange-abbr').value = abbr;
});

// Control buttons
document.getElementById('reset-series-btn').addEventListener('click', () => {
    if (!socket || !socket.connected) {
        showToast('Not connected to relay', true);
        return;
    }
    document.getElementById('blue-wins').value = '0';
    document.getElementById('orange-wins').value = '0';
    emitOverrides();
    showToast('Series score reset');
});

document.getElementById('switch-teams-btn').addEventListener('click', () => {
    if (!socket || !socket.connected) {
        showToast('Not connected to relay', true);
        return;
    }
    // Swap team name and abbreviation only (not colors)
    const swap = (blueId, orangeId) => {
        const temp = document.getElementById(blueId).value;
        document.getElementById(blueId).value = document.getElementById(orangeId).value;
        document.getElementById(orangeId).value = temp;
    };
    swap('blue-name', 'orange-name');
    swap('blue-abbr', 'orange-abbr');
    swap('blue-wins', 'orange-wins');
    
    // Swap logos in localStorage
    const blueLogo = localStorage.getItem('blueLogo');
    const orangeLogo = localStorage.getItem('orangeLogo');
    
    // Swap: set blue to orange's value, orange to blue's value
    if (orangeLogo) {
        localStorage.setItem('blueLogo', orangeLogo);
    } else {
        localStorage.removeItem('blueLogo');
    }
    
    if (blueLogo) {
        localStorage.setItem('orangeLogo', blueLogo);
    } else {
        localStorage.removeItem('orangeLogo');
    }
    
    // Update preview images with SWAPPED values
    const bluePreview = document.getElementById('blue-logo-preview');
    const orangePreview = document.getElementById('orange-logo-preview');
    bluePreview.innerHTML = orangeLogo ? `<img src="${orangeLogo}" alt="Blue logo">` : '';
    orangePreview.innerHTML = blueLogo ? `<img src="${blueLogo}" alt="Orange logo">` : '';
    
    // Note: colors are NOT swapped
    
    emitOverrides();
    showToast('Teams switched (logos swapped)');
});

document.getElementById('reset-data-btn').addEventListener('click', () => {
    if (!socket || !socket.connected) {
        showToast('Not connected to relay', true);
        return;
    }
    document.getElementById('blue-name').value = '';
    document.getElementById('blue-abbr').value = '';
    document.getElementById('blue-wins').value = '0';
    document.getElementById('orange-name').value = '';
    document.getElementById('orange-abbr').value = '';
    document.getElementById('orange-wins').value = '0';
    document.getElementById('blue-color').value = '#21afd7';
    document.getElementById('orange-color').value = '#fd5b00';
    document.getElementById('header-text').value = '';
    document.getElementById('header-text-full').value = '';
    document.getElementById('series-length').value = '7';
    
    // Reset logos
    localStorage.removeItem('blueLogo');
    localStorage.removeItem('orangeLogo');
    document.getElementById('blue-logo-preview').innerHTML = '';
    document.getElementById('orange-logo-preview').innerHTML = '';
    
    emitOverrides();
    showToast('Team data reset');
});

// Auto-save on input change
document.getElementById('blue-name').addEventListener('change', emitOverrides);
document.getElementById('orange-name').addEventListener('change', emitOverrides);
document.getElementById('blue-abbr').addEventListener('change', emitOverrides);
document.getElementById('orange-abbr').addEventListener('change', emitOverrides);
document.getElementById('blue-wins').addEventListener('change', emitOverrides);
document.getElementById('orange-wins').addEventListener('change', emitOverrides);
document.getElementById('blue-color').addEventListener('change', emitOverrides);
document.getElementById('orange-color').addEventListener('change', emitOverrides);
document.getElementById('series-length').addEventListener('change', emitOverrides);
document.getElementById('header-text').addEventListener('change', emitOverrides);
document.getElementById('header-text-full').addEventListener('change', emitOverrides);

function emitOverrides() {
    if (!socket || !socket.connected) return;

    const overrides = {
        blueName: document.getElementById('blue-name').value.trim(),
        orangeName: document.getElementById('orange-name').value.trim(),
        blueAbbr: document.getElementById('blue-abbr').value.trim().toUpperCase(),
        orangeAbbr: document.getElementById('orange-abbr').value.trim().toUpperCase(),
        blueColor: document.getElementById('blue-color').value,
        orangeColor: document.getElementById('orange-color').value,
        seriesLen: parseInt(document.getElementById('series-length').value),
        blueWins: parseInt(document.getElementById('blue-wins').value),
        orangeWins: parseInt(document.getElementById('orange-wins').value),
        headerText: document.getElementById('header-text').value.trim(),
        headerTextFull: document.getElementById('header-text-full').value.trim(),
        blueLogo: localStorage.getItem('blueLogo') || '',
        orangeLogo: localStorage.getItem('orangeLogo') || '',
        teamsSwapped: localStorage.getItem('teamsSwapped') === 'true'
    };

    socket.emit('overrides', overrides);
    console.log('📡 Sent overrides to overlay:', overrides);
}

// Toast notification
function showToast(message, isError = false) {
    const toast = document.createElement('div');
    toast.textContent = message;
    toast.style.cssText = `
        position: fixed;
        bottom: 20px;
        right: 20px;
        background: ${isError ? '#cc3333' : '#00d4ff'};
        color: ${isError ? '#fff' : '#000'};
        padding: 12px 16px;
        border-radius: 4px;
        font-weight: bold;
        z-index: 9999;
        animation: slideIn 0.3s ease;
    `;
    document.body.appendChild(toast);

    setTimeout(() => {
        toast.style.animation = 'slideOut 0.3s ease';
        setTimeout(() => toast.remove(), 300);
    }, 2000);
}

// Add animation styles
const style = document.createElement('style');
style.textContent = `
    @keyframes slideIn {
        from {
            transform: translateX(400px);
            opacity: 0;
        }
        to {
            transform: translateX(0);
            opacity: 1;
        }
    }
    @keyframes slideOut {
        from {
            transform: translateX(0);
            opacity: 1;
        }
        to {
            transform: translateX(400px);
            opacity: 0;
        }
    }
`;
document.head.appendChild(style);