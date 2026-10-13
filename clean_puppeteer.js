const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function cleanPuppeteer() {
    console.log('[Cleanup] Searching for orphaned Puppeteer Chrome processes...');
    try {
        const output = execSync('powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'chrome.exe\'\\" | Select-Object ProcessId, ExecutablePath | ConvertTo-Json"', { encoding: 'utf8' });
        const processes = JSON.parse(output || '[]');
        const list = Array.isArray(processes) ? processes : [processes];
        let killed = 0;

        for (const p of list) {
            if (p && p.ExecutablePath && (p.ExecutablePath.includes('.cache\\puppeteer') || p.ExecutablePath.includes('.cache/puppeteer'))) {
                try {
                    process.kill(p.ProcessId, 'SIGKILL');
                    console.log(`[Cleanup] Killed orphaned Chrome PID: ${p.ProcessId}`);
                    killed++;
                } catch (e) {
                    try {
                        execSync(`taskkill /F /PID ${p.ProcessId}`, { stdio: 'ignore' });
                        killed++;
                    } catch (err) {}
                }
            }
        }
        console.log(`[Cleanup] Total orphaned Puppeteer Chrome processes killed: ${killed}`);
    } catch (e) {
        console.warn('[Cleanup] Process scan notice:', e.message);
    }

    // Clean lockfiles in OpenWA sessions directory
    const openwaSessions = path.join(__dirname, 'OpenWA', 'data', 'sessions');
    if (fs.existsSync(openwaSessions)) {
        try {
            const dirs = fs.readdirSync(openwaSessions);
            for (const d of dirs) {
                const sessionDir = path.join(openwaSessions, d);
                if (fs.statSync(sessionDir).isDirectory()) {
                    const lockFiles = [
                        path.join(sessionDir, 'lockfile'),
                        path.join(sessionDir, 'DevToolsActivePort'),
                        path.join(sessionDir, 'Default', 'lockfile'),
                        path.join(sessionDir, 'Default', 'DevToolsActivePort')
                    ];
                    for (const f of lockFiles) {
                        if (fs.existsSync(f)) {
                            try {
                                fs.unlinkSync(f);
                                console.log(`[Cleanup] Removed stale lockfile: ${f}`);
                            } catch (e) {}
                        }
                    }
                }
            }
        } catch (e) {}
    }

    // Clean lockfiles in .wwebjs_auth directory
    const wwebjsDir = path.join(__dirname, '.wwebjs_auth', 'session');
    if (fs.existsSync(wwebjsDir)) {
        const lockFiles = [
            path.join(wwebjsDir, 'lockfile'),
            path.join(wwebjsDir, 'DevToolsActivePort')
        ];
        for (const f of lockFiles) {
            if (fs.existsSync(f)) {
                try {
                    fs.unlinkSync(f);
                    console.log(`[Cleanup] Removed stale lockfile: ${f}`);
                } catch (e) {}
            }
        }
    }

    console.log('[Cleanup] Cleanup complete.');
}

cleanPuppeteer();
module.exports = cleanPuppeteer;
