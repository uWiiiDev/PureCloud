// PureCloud Desktop Sync Client UI Controller
(function () {
    const isTauri = typeof window.__TAURI__ !== 'undefined';
    const invoke = isTauri
        ? (window.__TAURI__.core ? window.__TAURI__.core.invoke : window.__TAURI__.invoke)
        : mockInvoke;

    let currentConfig = null;
    let pollTimer = null;
    let isPaused = false;

    // DOM Elements
    const viewSetup = document.getElementById('view-setup');
    const viewDashboard = document.getElementById('view-dashboard');
    const statusPill = document.getElementById('status-pill');
    const statusText = document.getElementById('status-text');
    const dashLocalPath = document.getElementById('dash-local-path');
    const dashLastSync = document.getElementById('dash-last-sync');
    const dashProgressCard = document.getElementById('dash-progress-card');
    const progressFilename = document.getElementById('progress-filename');
    const progressPercent = document.getElementById('progress-percent');
    const progressBarFill = document.getElementById('progress-bar-fill');
    const quotaText = document.getElementById('quota-text');
    const quotaFill = document.getElementById('quota-fill');
    const activityList = document.getElementById('activity-list');
    const activityCount = document.getElementById('activity-count');
    const settingsModal = document.getElementById('settings-modal');

    // Init
    init();

    async function init() {
        bindEvents();
        await loadConfig();
        await refreshStatus();
        startPolling();
    }

    function bindEvents() {
        // Theme toggle
        document.getElementById('btn-theme-toggle').addEventListener('click', toggleTheme);

        // Settings open/close
        document.getElementById('btn-open-settings').addEventListener('click', openSettings);
        document.getElementById('btn-close-settings').addEventListener('click', closeSettings);
        document.getElementById('btn-cancel-settings').addEventListener('click', closeSettings);

        // Actions
        document.getElementById('btn-sync-now').addEventListener('click', async () => {
            try {
                await invoke('trigger_sync');
                await refreshStatus();
            } catch (e) {
                console.error(e);
            }
        });

        document.getElementById('btn-pause-toggle').addEventListener('click', async (e) => {
            try {
                isPaused = await invoke('toggle_pause');
                e.target.textContent = isPaused ? '▶️ Fortsetzen' : '⏸️ Pause';
                await refreshStatus();
            } catch (err) {
                console.error(err);
            }
        });

        document.getElementById('btn-open-folder').addEventListener('click', () => invoke('open_local_folder'));
        document.getElementById('btn-open-web').addEventListener('click', () => invoke('open_web_url'));

        // Setup Form
        document.getElementById('btn-test-conn').addEventListener('click', testSetupConnection);
        document.getElementById('setup-form').addEventListener('submit', handleSetupSubmit);

        // Settings Form
        document.getElementById('settings-form').addEventListener('submit', handleSettingsSubmit);
    }

    async function loadConfig() {
        try {
            currentConfig = await invoke('get_config');
            if (currentConfig && currentConfig.theme) {
                document.documentElement.setAttribute('data-theme', currentConfig.theme);
            }
            populateForm(currentConfig);
        } catch (e) {
            console.error('Konnte Konfiguration nicht laden:', e);
        }
    }

    function populateForm(cfg) {
        if (!cfg) return;
        // Setup fields
        document.getElementById('setup-server-url').value = cfg.server_url || '';
        document.getElementById('setup-username').value = cfg.username || '';
        document.getElementById('setup-password').value = cfg.token_or_password || '';
        document.getElementById('setup-local-path').value = cfg.local_path || '';

        // Modal fields
        document.getElementById('cfg-server-url').value = cfg.server_url || '';
        document.getElementById('cfg-username').value = cfg.username || '';
        document.getElementById('cfg-password').value = cfg.token_or_password || '';
        document.getElementById('cfg-local-path').value = cfg.local_path || '';
        document.getElementById('cfg-interval').value = cfg.sync_interval_secs || 30;
        document.getElementById('cfg-auto-start').checked = !!cfg.auto_start;
    }

    async function refreshStatus() {
        try {
            const data = await invoke('get_status');
            renderStatus(data);
        } catch (e) {
            console.error('Status-Abruf fehlgeschlagen:', e);
        }
    }

    function renderStatus(data) {
        if (!data) return;

        // View toggle
        if (!data.is_configured) {
            viewSetup.classList.remove('hidden');
            viewDashboard.classList.add('hidden');
            statusPill.className = 'status-pill status-paused';
            statusText.textContent = 'Nicht eingerichtet';
            return;
        }

        viewSetup.classList.add('hidden');
        viewDashboard.classList.remove('hidden');

        // Path & Time
        dashLocalPath.textContent = data.local_path;
        if (data.last_sync_time) {
            const date = new Date(data.last_sync_time);
            dashLastSync.textContent = `Letzter Abgleich: ${date.toLocaleTimeString('de-DE')}`;
        } else {
            dashLastSync.textContent = 'Erster Abgleich steht aus…';
        }

        // Status pill
        statusPill.className = 'status-pill';
        if (data.status === 'Syncing') {
            statusPill.classList.add('status-syncing');
            statusText.textContent = 'Synchronisiere…';
        } else if (data.status === 'Paused') {
            statusPill.classList.add('status-paused');
            statusText.textContent = 'Pausiert';
        } else if (typeof data.status === 'object' && data.status.Error) {
            statusPill.classList.add('status-error');
            statusText.textContent = 'Fehler';
        } else {
            statusPill.classList.add('status-idle');
            statusText.textContent = 'Synchronisiert';
        }

        // Progress
        if (data.progress) {
            dashProgressCard.classList.remove('hidden');
            progressFilename.textContent = data.progress.current_file;
            progressPercent.textContent = `${data.progress.percent}%`;
            progressBarFill.style.width = `${data.progress.percent}%`;
        } else {
            dashProgressCard.classList.add('hidden');
        }

        // Quota
        if (data.quota && data.quota.total_bytes > 0) {
            const usedStr = formatBytes(data.quota.used_bytes);
            const totalStr = formatBytes(data.quota.total_bytes);
            quotaText.textContent = `${usedStr} von ${totalStr} belegt (${data.quota.used_percent}%)`;
            quotaFill.style.width = `${data.quota.used_percent}%`;
        } else {
            quotaText.textContent = 'Speicherplatz: Unbegrenzt / Nicht konfiguriert';
            quotaFill.style.width = '0%';
        }

        // Activities
        renderActivities(data.recent_activities || []);
    }

    function renderActivities(items) {
        activityCount.textContent = `${items.length} Vorgänge`;
        if (items.length === 0) {
            activityList.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">📁</div>
                    <div>Noch keine Aktivitäten protokolliert.</div>
                    <div class="small muted">Dateien werden in Echtzeit überwacht und synchronisiert.</div>
                </div>
            `;
            return;
        }

        activityList.innerHTML = items.map((it) => {
            const badgeClass =
                it.action === 'upload' ? 'badge-upload' :
                it.action === 'download' ? 'badge-download' :
                it.action === 'conflict' ? 'badge-conflict' : 'badge-delete';

            const badgeLabel =
                it.action === 'upload' ? '⬆️ Hochgeladen' :
                it.action === 'download' ? '⬇️ Heruntergeladen' :
                it.action === 'conflict' ? '⚠️ Konflikt' : '🗑️ Gelöscht';

            const timeStr = new Date(it.timestamp).toLocaleTimeString('de-DE');
            const sizeStr = it.size_bytes > 0 ? ` · ${formatBytes(it.size_bytes)}` : '';

            return `
                <div class="activity-item">
                    <div style="display:flex;align-items:center;gap:8px;overflow:hidden">
                        <span class="activity-badge ${badgeClass}">${badgeLabel}</span>
                        <strong style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(it.path)}</strong>
                    </div>
                    <div class="muted" style="font-size:11px;white-space:nowrap">${timeStr}${sizeStr}</div>
                </div>
            `;
        }).join('');
    }

    async function testSetupConnection() {
        const url = document.getElementById('setup-server-url').value.trim();
        const user = document.getElementById('setup-username').value.trim();
        const pass = document.getElementById('setup-password').value;
        const msg = document.getElementById('setup-msg');

        if (!url || !user || !pass) {
            showMsg(msg, 'Bitte alle Felder ausfüllen.', 'error');
            return;
        }

        showMsg(msg, '⏳ Prüfe Verbindung zum PureCloud-Server…', 'success');

        try {
            const res = await invoke('test_connection', {
                serverUrl: url,
                username: user,
                passwordOrToken: pass,
            });
            showMsg(msg, `✅ ${res}`, 'success');
        } catch (err) {
            showMsg(msg, `❌ ${err}`, 'error');
        }
    }

    async function handleSetupSubmit(e) {
        e.preventDefault();
        const msg = document.getElementById('setup-msg');
        const cfg = {
            server_url: document.getElementById('setup-server-url').value.trim(),
            username: document.getElementById('setup-username').value.trim(),
            token_or_password: document.getElementById('setup-password').value,
            local_path: document.getElementById('setup-local-path').value.trim(),
            sync_interval_secs: 30,
            is_paused: false,
            auto_start: false,
            theme: document.documentElement.getAttribute('data-theme') || 'dark',
        };

        try {
            await invoke('save_config', { newConfig: cfg });
            currentConfig = cfg;
            showMsg(msg, '✅ Erfolgreich verbunden! Starte Synchronisation…', 'success');
            setTimeout(async () => {
                await refreshStatus();
            }, 800);
        } catch (err) {
            showMsg(msg, `❌ Fehler beim Speichern: ${err}`, 'error');
        }
    }

    async function handleSettingsSubmit(e) {
        e.preventDefault();
        const msg = document.getElementById('cfg-msg');
        const cfg = {
            server_url: document.getElementById('cfg-server-url').value.trim(),
            username: document.getElementById('cfg-username').value.trim(),
            token_or_password: document.getElementById('cfg-password').value,
            local_path: document.getElementById('cfg-local-path').value.trim(),
            sync_interval_secs: Number(document.getElementById('cfg-interval').value) || 30,
            is_paused: isPaused,
            auto_start: document.getElementById('cfg-auto-start').checked,
            theme: document.documentElement.getAttribute('data-theme') || 'dark',
        };

        try {
            await invoke('save_config', { newConfig: cfg });
            currentConfig = cfg;
            closeSettings();
            await refreshStatus();
        } catch (err) {
            showMsg(msg, `❌ Fehler: ${err}`, 'error');
        }
    }

    function openSettings() {
        populateForm(currentConfig);
        settingsModal.classList.remove('hidden');
    }

    function closeSettings() {
        settingsModal.classList.add('hidden');
    }

    function toggleTheme() {
        const cur = document.documentElement.getAttribute('data-theme') || 'dark';
        const next = cur === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        if (currentConfig) {
            currentConfig.theme = next;
            invoke('save_config', { newConfig: currentConfig });
        }
    }

    function startPolling() {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = setInterval(refreshStatus, 1500);
    }

    function showMsg(el, text, type) {
        el.className = `alert-box alert-${type}`;
        el.textContent = text;
        el.classList.remove('hidden');
    }

    function formatBytes(bytes) {
        if (!bytes || bytes === 0) return '0 B';
        const k = 1024;
        const dm = 1;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // Mock Invoke for local browser testing without Tauri
    async function mockInvoke(cmd, args) {
        console.log('[Mock Invoke]', cmd, args);
        if (cmd === 'get_config') {
            return {
                server_url: 'https://cloud.purecloud.local',
                username: 'admin',
                token_or_password: 'mock_password',
                local_path: '/home/user/PureCloud',
                sync_interval_secs: 30,
                is_paused: false,
                auto_start: false,
                theme: 'dark',
            };
        }
        if (cmd === 'get_status') {
            return {
                status: 'Idle',
                status_text: 'Synchronisiert',
                is_configured: true,
                local_path: '/home/user/PureCloud',
                server_url: 'https://cloud.purecloud.local',
                last_sync_time: new Date().toISOString(),
                progress: null,
                quota: { used_bytes: 4820000000, total_bytes: 20000000000, used_percent: 24 },
                recent_activities: [
                    { id: '1', path: 'Dokumente/Projektplan.pdf', action: 'upload', size_bytes: 1420000, timestamp: new Date().toISOString(), status: 'success' },
                    { id: '2', path: 'Bilder/Urlaub.webp', action: 'download', size_bytes: 3820000, timestamp: new Date(Date.now() - 3600000).toISOString(), status: 'success' },
                ],
            };
        }
        if (cmd === 'test_connection') {
            return 'Verbindung zum Server erfolgreich.';
        }
        return {};
    }
})();
