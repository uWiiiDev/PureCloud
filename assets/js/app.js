(() => {
    'use strict';

    const CHUNK_SIZE = 2 * 1024 * 1024; // 2 MB per chunk for universal shared-hosting compatibility

    const state = {
        appName: window.CLOUD_BOOT?.app_name || 'PureCloud',
        user: window.CLOUD_BOOT?.user || null,
        csrfToken: window.CLOUD_BOOT?.csrf_token || '',
        baseUrl: window.CLOUD_BOOT?.base_url || '',
        webdavUrl: window.CLOUD_BOOT?.webdav_url || '',
        view: 'files',          // 'files' | 'shared' | 'my_shares' | 'vault' | 'trash'
        currentFolderId: null,
        permission: 'owner',
        search: '',
        layout: localStorage.getItem('cloud_layout') || 'list', // 'list' | 'grid' | 'split'
        theme: localStorage.getItem('cloud_theme') || 'dark',
        breadcrumbs: [],
        folders: [],
        files: [],
        selected: new Map(),    // key: "folder:1" or "file:5" -> {type, id, name, pane}
        // Right pane state for Split-View ('split')
        rightFolderId: null,
        rightBreadcrumbs: [],
        rightFolders: [],
        rightFiles: [],
        splitDropMode: 'move',  // 'move' | 'copy'
        clipboard: null,        // { mode: 'copy' | 'cut', items: [{type, id, name}] }
        undoStack: [],          // Stack of undoable file operations
        sortBy: 'name',         // 'name' | 'size' | 'date'
        sortDir: 'asc',         // 'asc' | 'desc'
        filterType: 'all',      // 'all' | 'folder' | 'doc' | 'image' | 'video' | 'audio' | 'zip' | 'encrypted' | 'shared'
        filterText: '',         // Substring filter on item name
        filterMenuOpen: false,
    };

    // Apply saved theme immediately
    document.documentElement.setAttribute('data-theme', state.theme);

    // DOM Helpers
    const $ = (sel, root = document) => root.querySelector(sel);
    const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

    function esc(str) {
        const div = document.createElement('div');
        div.textContent = str ?? '';
        return div.innerHTML;
    }

    function formatBytes(bytes) {
        const b = Number(bytes) || 0;
        if (b <= 0) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.min(Math.floor(Math.log(b) / Math.log(1024)), units.length - 1);
        const val = b / Math.pow(1024, i);
        return (i > 1 ? val.toFixed(2) : Math.round(val)) + ' ' + units[i];
    }

    function toast(msg, type = 'success') {
        const container = $('#toast-container');
        if (!container) return;
        const el = document.createElement('div');
        el.className = `toast toast-${type}`;
        el.innerHTML = `<span>${type === 'error' ? '⚠️' : '✅'}</span><span>${esc(msg)}</span>`;
        container.appendChild(el);
        setTimeout(() => {
            el.style.opacity = '0';
            setTimeout(() => el.remove(), 250);
        }, 3600);
    }

    async function parseJsonResponse(res) {
        const text = await res.text();
        try {
            return JSON.parse(text);
        } catch (_) {
            if (res.status === 404 && window.location.pathname.startsWith('/files')) {
                window.location.href = '/';
                throw new Error('Weiterleitung auf Hauptdomain…');
            }
            throw new Error(`Server-Antwort ungültig (HTTP ${res.status}). Bitte Seite neu laden.`);
        }
    }

    async function apiGet(params) {
        const qs = new URLSearchParams(params).toString();
        const res = await fetch(`api.php?${qs}`, {
            credentials: 'same-origin',
            headers: { 'Accept': 'application/json' },
        });
        const data = await parseJsonResponse(res);
        if (!res.ok || !data.ok) {
            if (data.auth_required) {
                showAuthScreen();
            }
            throw new Error(data.error || 'Anfrage fehlgeschlagen.');
        }
        return data;
    }

    function summarizeItemsDetail(list) {
        if (!Array.isArray(list) || list.length === 0) return '';
        if (list.length === 1 && list[0].name) return `„${list[0].name}“`;
        if (list[0]?.name) return `„${list[0].name}“ (+${list.length - 1})`;
        return `${list.length} Element(e)`;
    }

    function pushUndo(entry) {
        const now = new Date();
        const timeStr = now.toTimeString().slice(0, 5);
        state.undoStack.push({
            uid: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            time: timeStr,
            ...entry,
        });
        if (state.undoStack.length > 20) {
            state.undoStack.shift();
        }
        updateUndoButton();
    }

    function updateUndoButton() {
        const btn = $('#btn-undo');
        const menu = $('#undo-history-menu');
        if (!btn) return;
        const hasUndo = state.undoStack.length > 0;
        btn.disabled = !hasUndo;
        btn.style.opacity = hasUndo ? '1' : '0.4';
        if (hasUndo) {
            const top = state.undoStack[state.undoStack.length - 1];
            btn.title = `Verlauf (${state.undoStack.length}) – Letzte Aktion: ${top.label} ${top.detail || ''} (Strg+Z)`;
        } else {
            btn.title = 'Keine Aktion zum Rückgängigmachen (Strg+Z)';
            menu?.classList.add('hidden');
        }
        if (menu && !menu.classList.contains('hidden')) {
            renderUndoHistoryMenu();
        }
    }

    function renderUndoHistoryMenu() {
        const menu = $('#undo-history-menu');
        if (!menu) return;
        if (state.undoStack.length === 0) {
            menu.classList.add('hidden');
            return;
        }

        // Show newest first, allow clicking ANY entry independently of chronology
        const reversed = [...state.undoStack].reverse();
        const rows = reversed.map((e) => `
            <button type="button" class="dropdown-item" data-undo-uid="${esc(e.uid)}" style="justify-content:space-between;gap:0.6rem">
                <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                    ${e.icon || '↩️'} <strong>${esc(e.label)}</strong>
                    <span class="muted small">${esc(e.detail || '')}</span>
                </span>
                <span class="muted small" style="flex-shrink:0">↩️</span>
            </button>
        `).join('');

        menu.innerHTML = `
            <div class="context-menu-header" style="display:flex;justify-content:space-between;align-items:center">
                <span>Rückgängig machen (${state.undoStack.length})</span>
                <button type="button" class="btn btn-ghost btn-sm" id="btn-clear-undo-stack" style="padding:0.1rem 0.4rem;font-size:0.72rem">Leeren</button>
            </div>
            <div style="max-height:280px;overflow-y:auto;display:flex;flex-direction:column;gap:0.15rem">
                ${rows}
            </div>
        `;

        $$('[data-undo-uid]', menu).forEach((itemBtn) => {
            itemBtn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                const uid = itemBtn.getAttribute('data-undo-uid');
                executeUndoByUid(uid);
            });
        });

        $('#btn-clear-undo-stack', menu)?.addEventListener('click', (ev) => {
            ev.stopPropagation();
            state.undoStack = [];
            updateUndoButton();
        });
    }

    async function executeUndoByUid(uid) {
        const idx = state.undoStack.findIndex((x) => x.uid === uid);
        if (idx === -1) return;
        const [entry] = state.undoStack.splice(idx, 1);
        updateUndoButton();

        try {
            if (entry.type === 'move') {
                await apiPost('undo_moves', { moves: entry.moves, _skip_undo: true });
            } else if (entry.type === 'trash') {
                await apiPost('restore', { items: entry.items, _skip_undo: true });
            } else if (entry.type === 'copy') {
                await apiPost('delete_permanent', { items: entry.created_items, _skip_undo: true });
            } else if (entry.type === 'rename') {
                await apiPost('rename', {
                    type: entry.item_type,
                    id: entry.id,
                    name: entry.old_name,
                    _skip_undo: true,
                });
            }
            toast(`↩️ Rückgängig: ${entry.label} ${entry.detail || ''}`);
            loadCurrentView();
        } catch (err) {
            toast(err.message, 'error');
        }
    }

    async function executeUndo() {
        if (state.undoStack.length === 0) return;
        const newest = state.undoStack[state.undoStack.length - 1];
        await executeUndoByUid(newest.uid);
    }

    $('#btn-undo')?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (state.undoStack.length === 0) return;
        $('#new-action-menu')?.classList.add('hidden');
        const menu = $('#undo-history-menu');
        if (!menu) return;
        const willOpen = menu.classList.contains('hidden');
        if (willOpen) {
            renderUndoHistoryMenu();
            menu.classList.remove('hidden');
        } else {
            menu.classList.add('hidden');
        }
    });

    async function apiPost(action, payload = {}) {
        const res = await fetch(`api.php?action=${encodeURIComponent(action)}`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'X-CSRF-Token': state.csrfToken,
            },
            body: JSON.stringify({ action, ...payload }),
        });
        const data = await parseJsonResponse(res);
        if (!res.ok || !data.ok) {
            if (data.auth_required) {
                showAuthScreen();
            }
            throw new Error(data.error || 'Aktion fehlgeschlagen.');
        }

        // Automatically record undoable file operations
        if (!payload._skip_undo) {
            if (action === 'move' && Array.isArray(data.undo_moves) && data.undo_moves.length > 0) {
                pushUndo({
                    type: 'move',
                    icon: '✂️',
                    moves: data.undo_moves,
                    label: 'Verschoben',
                    detail: summarizeItemsDetail(data.undo_moves),
                });
            } else if (action === 'trash' && Array.isArray(payload.items) && payload.items.length > 0 && data.count > 0) {
                pushUndo({
                    type: 'trash',
                    icon: '🗑️',
                    items: payload.items,
                    label: 'Gelöscht',
                    detail: summarizeItemsDetail(payload.items),
                });
            } else if (action === 'copy' && Array.isArray(data.created_items) && data.created_items.length > 0) {
                pushUndo({
                    type: 'copy',
                    icon: '📋',
                    created_items: data.created_items,
                    label: 'Kopiert',
                    detail: summarizeItemsDetail(data.created_items),
                });
            } else if (action === 'rename' && payload.old_name && payload.old_name !== payload.name) {
                pushUndo({
                    type: 'rename',
                    icon: '✏️',
                    item_type: payload.type,
                    id: payload.id,
                    old_name: payload.old_name,
                    label: 'Umbenannt',
                    detail: `„${payload.old_name}“ → „${payload.name}“`,
                });
            }
        }

        return data;
    }

    // Modal System & Browser History Integration
    let lastHistoryState = null;
    let isRestoringHistory = false;
    let activeUploadCount = 0;

    function pushNavigationState() {
        if (!state.user || isRestoringHistory) return;

        const curFolder = state.currentFolderId;
        const curView = state.view;
        const curSearch = state.search || '';

        if (lastHistoryState && lastHistoryState.view === curView && lastHistoryState.folderId === curFolder && lastHistoryState.search === curSearch) {
            return;
        }

        const newState = {
            view: curView,
            folderId: curFolder,
            search: curSearch,
            modal: false,
        };

        history.pushState(newState, '');
        lastHistoryState = newState;
    }

    function initBrowserHistory() {
        if (!state.user) return;
        // 1. Initial trap state at the base to intercept accidental browser back exits
        history.replaceState({ isRootTrap: true, view: 'files', folderId: null, search: '' }, '');
        // 2. Active state
        const initState = {
            view: state.view || 'files',
            folderId: state.currentFolderId || null,
            search: state.search || '',
            modal: false,
        };
        history.pushState(initState, '');
        lastHistoryState = initState;
    }

    function openModal(title, htmlContent, large = false) {
        const backdrop = $('#modal-backdrop');
        const dialog = $('#modal-dialog');
        const wasHidden = backdrop.classList.contains('hidden');

        $('#modal-title').textContent = title;
        $('#modal-body').innerHTML = htmlContent;
        dialog.classList.toggle('modal-lg', large);
        backdrop.classList.remove('hidden');

        if (wasHidden && state.user) {
            history.pushState({ ...(lastHistoryState || { view: state.view, folderId: state.currentFolderId, search: '' }), modal: true }, '');
        }
    }

    let activeOcrWorker = null;
    let activeVoiceStream = null;

    function closeModal(fromHistory = false) {
        const backdrop = $('#modal-backdrop');
        if (backdrop.classList.contains('hidden')) return;

        if (activeOcrWorker) {
            activeOcrWorker.terminate().catch(() => {});
            activeOcrWorker = null;
        }

        if (activeVoiceStream) {
            try { activeVoiceStream.getTracks().forEach((t) => t.stop()); } catch (_) {}
            activeVoiceStream = null;
        }

        backdrop.classList.add('hidden');
        $('#modal-body').innerHTML = '';

        if (!fromHistory && history.state?.modal) {
            history.back();
        }
    }

    $('#modal-close')?.addEventListener('click', () => closeModal());
    $('#modal-backdrop')?.addEventListener('click', (e) => {
        if (e.target.id === 'modal-backdrop') closeModal();
    });
    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
            e.preventDefault();
            openSpotlight();
            return;
        }
        if (e.key === 'Escape' && !$('#modal-backdrop').classList.contains('hidden')) {
            closeModal();
        }
    });

    window.addEventListener('popstate', (e) => {
        // 0. Close spotlight if open
        if (spotlightEl && !spotlightEl.classList.contains('hidden')) {
            closeSpotlight();
            if (lastHistoryState) history.pushState(lastHistoryState, '');
            return;
        }

        // 1. Close mobile sidebar if open
        if ($('#sidebar')?.classList.contains('open')) {
            setMobileSidebarOpen(false);
            if (lastHistoryState) history.pushState(lastHistoryState, '');
            return;
        }

        // 2. Close context menu if open
        if (!$('#context-menu')?.classList.contains('hidden')) {
            closeContextMenu();
            if (lastHistoryState) history.pushState(lastHistoryState, '');
            return;
        }

        // 3. Close open modal if active
        const modalBackdrop = $('#modal-backdrop');
        if (modalBackdrop && !modalBackdrop.classList.contains('hidden')) {
            closeModal(true);
            return;
        }

        // 4. Base root trap reached: prevent leaving the cloud accidentally!
        if (!e.state || e.state.isRootTrap) {
            if (state.view !== 'files' || state.currentFolderId !== null || (state.search || '') !== '') {
                // Navigate back to main files root
                isRestoringHistory = true;
                state.view = 'files';
                state.currentFolderId = null;
                state.search = '';
                $('#search-input').value = '';
                setActiveNavView('files');
                loadCurrentView().finally(() => {
                    isRestoringHistory = false;
                    const rootState = { view: 'files', folderId: null, search: '', modal: false };
                    history.pushState(rootState, '');
                    lastHistoryState = rootState;
                });
            } else {
                // Already on root level -> show informative toast and stay safely in PureCloud
                toast('Sie befinden sich bereits auf der obersten Ebene von PureCloud.', 'info');
                const stayState = { view: 'files', folderId: null, search: '', modal: false };
                history.pushState(stayState, '');
                lastHistoryState = stayState;
            }
            return;
        }

        // 5. Restore view / folder / search from history state
        const targetView = e.state.view || 'files';
        const targetFolder = e.state.folderId !== undefined ? e.state.folderId : null;
        const targetSearch = e.state.search || '';

        if (targetView !== state.view || targetFolder !== state.currentFolderId || targetSearch !== (state.search || '')) {
            isRestoringHistory = true;
            state.view = targetView;
            state.currentFolderId = targetFolder;
            state.search = targetSearch;
            $('#search-input').value = targetSearch;
            setActiveNavView(state.view);
            lastHistoryState = { view: state.view, folderId: state.currentFolderId, search: state.search, modal: false };
            loadCurrentView().finally(() => {
                isRestoringHistory = false;
            });
        }
    });

    // Warn before closing tab or navigating away while uploads are running
    window.addEventListener('beforeunload', (e) => {
        if (activeUploadCount > 0) {
            e.preventDefault();
            e.returnValue = '';
            return '';
        }
    });

    // Spotlight Quick Search (Strg + K)
    let spotlightEl = null;
    let spotlightActiveIdx = -1;
    let spotlightItems = [];

    function openSpotlight() {
        if (!state.user) return;
        closeContextMenu();
        if (spotlightEl) {
            spotlightEl.classList.remove('hidden');
            const inp = $('#spotlight-input', spotlightEl);
            if (inp) {
                inp.value = '';
                inp.focus();
            }
            renderSpotlightResults({ folders: [], files: [] });
            return;
        }

        spotlightEl = document.createElement('div');
        spotlightEl.className = 'spotlight-backdrop';
        spotlightEl.innerHTML = `
            <div class="spotlight-dialog" onclick="event.stopPropagation()">
                <div class="spotlight-input-wrap">
                    <span style="font-size:1.15rem">🔍</span>
                    <input type="text" id="spotlight-input" class="spotlight-input" placeholder="Schnellsuche nach Dateien, Ordnern, Notizen…" autocomplete="off">
                    <kbd class="search-kbd" id="btn-spotlight-esc" style="cursor:pointer;pointer-events:auto">Esc</kbd>
                </div>
                <div class="spotlight-results" id="spotlight-results">
                    <p class="muted small" style="padding:1rem;text-align:center;margin:0">Tippen Sie einen Begriff ein, um blitzschnell zu suchen…</p>
                </div>
                <div class="spotlight-footer">
                    <span>Navigation: <strong>↑</strong> <strong>↓</strong> · Auswählen: <strong>Enter</strong></span>
                    <span>PureCloud Schnellsuche</span>
                </div>
            </div>
        `;
        document.body.appendChild(spotlightEl);

        spotlightEl.addEventListener('click', (e) => {
            if (e.target === spotlightEl) closeSpotlight();
        });
        $('#btn-spotlight-esc', spotlightEl)?.addEventListener('click', closeSpotlight);

        const inp = $('#spotlight-input', spotlightEl);
        let debounceTimer = null;

        inp.addEventListener('input', () => {
            clearTimeout(debounceTimer);
            const q = inp.value.trim();
            if (q.length === 0) {
                $('#spotlight-results', spotlightEl).innerHTML = '<p class="muted small" style="padding:1rem;text-align:center;margin:0">Tippen Sie einen Begriff ein, um blitzschnell zu suchen…</p>';
                spotlightItems = [];
                spotlightActiveIdx = -1;
                return;
            }
            debounceTimer = setTimeout(async () => {
                try {
                    const res = await apiGet({ action: 'quick_search', q });
                    renderSpotlightResults(res.data, q);
                } catch (err) {
                    console.warn('Quick search failed:', err);
                }
            }, 100);
        });

        inp.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                closeSpotlight();
            } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                navigateSpotlight(1);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                navigateSpotlight(-1);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                executeSpotlightSelection();
            }
        });

        inp.focus();
    }

    function closeSpotlight() {
        if (spotlightEl) {
            spotlightEl.classList.add('hidden');
        }
    }

    function renderSpotlightResults(data, query = '') {
        const resultsBox = $('#spotlight-results', spotlightEl);
        if (!resultsBox) return;

        const folders = data.folders || [];
        const files = data.files || [];
        spotlightItems = [
            ...folders.map((f) => ({ ...f, itemType: 'folder' })),
            ...files.map((fl) => ({ ...fl, itemType: 'file' })),
        ];
        spotlightActiveIdx = spotlightItems.length > 0 ? 0 : -1;

        if (spotlightItems.length === 0) {
            resultsBox.innerHTML = query.trim().length === 0
                ? '<p class="muted small" style="padding:1rem;text-align:center;margin:0">Tippen Sie einen Begriff ein, um blitzschnell zu suchen…</p>'
                : '<p class="muted small" style="padding:1rem;text-align:center;margin:0">Keine passenden Einträge gefunden.</p>';
            return;
        }

        resultsBox.innerHTML = spotlightItems.map((it, idx) => {
            const isF = it.itemType === 'folder';
            const icon = isF ? '📁' : fileIcon(it);
            const sub = isF
                ? `Ordnerpfad: ${esc(it.path || it.name)}`
                : `${formatBytes(it.size_bytes)} · in ${esc(it.folder_name || 'Hauptverzeichnis')}`;
            return `
                <div class="spotlight-item ${idx === 0 ? 'active' : ''}" data-sp-idx="${idx}">
                    <div class="spotlight-item-icon">${icon}</div>
                    <div class="spotlight-item-text">
                        <div class="spotlight-item-name">
                            ${it.color_tag ? `<span class="color-tag-dot color-${esc(it.color_tag)}"></span>` : ''}
                            <span>${esc(it.name)}</span>
                            ${it.notes ? '<span class="item-note-icon">📝</span>' : ''}
                        </div>
                        <div class="spotlight-item-sub">${sub}</div>
                    </div>
                </div>
            `;
        }).join('');

        $$('[data-sp-idx]', resultsBox).forEach((el) => {
            el.addEventListener('click', () => {
                spotlightActiveIdx = Number(el.dataset.spIdx);
                executeSpotlightSelection();
            });
        });
    }

    function navigateSpotlight(delta) {
        if (spotlightItems.length === 0) return;
        spotlightActiveIdx = (spotlightActiveIdx + delta + spotlightItems.length) % spotlightItems.length;
        $$('.spotlight-item', spotlightEl).forEach((el, idx) => {
            el.classList.toggle('active', idx === spotlightActiveIdx);
            if (idx === spotlightActiveIdx) el.scrollIntoView({ block: 'nearest' });
        });
    }

    function executeSpotlightSelection() {
        if (spotlightActiveIdx < 0 || spotlightActiveIdx >= spotlightItems.length) return;
        const it = spotlightItems[spotlightActiveIdx];
        closeSpotlight();
        if (it.itemType === 'folder') {
            state.view = 'files';
            state.currentFolderId = it.id;
            state.search = '';
            $('#search-input').value = '';
            setActiveNavView('files');
            loadCurrentView();
        } else {
            openFileModal(it);
        }
    }

    // QR-Code Modal Helper
    async function showQrModal(url, title = '📱 QR-Code für Freigabe') {
        try {
            const res = await apiGet({ action: 'share_qr', url });
            openModal(title, `
                <div style="text-align:center;padding:0.75rem 0">
                    <div style="display:inline-block;padding:12px;background:#ffffff;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,0.12)">
                        ${res.qr_svg}
                    </div>
                    <p class="small muted" style="margin:1rem auto 0.75rem;max-width:320px">
                        Scannen Sie diesen Code mit der Smartphone-Kamera, um die Datei direkt auf Ihrem Mobilgerät zu öffnen.
                    </p>
                    <div class="form-row" style="max-width:360px;margin:0 auto">
                        <input type="text" class="input small" value="${esc(url)}" readonly onclick="this.select()" style="text-align:center">
                        <button type="button" class="btn btn-primary btn-sm" id="btn-qr-copy">Kopieren</button>
                    </div>
                </div>
            `);
            $('#btn-qr-copy')?.addEventListener('click', () => {
                navigator.clipboard?.writeText(url);
                toast('Link kopiert!');
            });
        } catch (err) {
            toast(err.message, 'error');
        }
    }

    // Floating Audio Dock Player
    function playDockAudio(file) {
        let dock = $('#audio-dock');
        if (!dock) {
            dock = document.createElement('div');
            dock.id = 'audio-dock';
            dock.className = 'audio-dock-player';
            document.body.appendChild(dock);
        }
        const streamUrl = `api.php?action=download&id=${file.id}&inline=1`;
        dock.innerHTML = `
            <div class="audio-dock-inner">
                <div class="audio-dock-header">
                    <div class="audio-dock-title" title="${esc(file.name)}">
                        <span>🎵</span>
                        <span>${esc(file.name)}</span>
                    </div>
                    <button type="button" class="audio-dock-close" id="btn-audio-dock-close" title="Schließen">✕</button>
                </div>
                <audio id="audio-dock-element" controls autoplay src="${streamUrl}"></audio>
            </div>
        `;
        dock.classList.remove('hidden');
        $('#btn-audio-dock-close', dock)?.addEventListener('click', () => {
            const a = $('#audio-dock-element', dock);
            if (a) a.pause();
            dock.classList.add('hidden');
        });
    }

    // Auth & Boot
    let active2faMethod = 'totp';
    let pending2faMaskedEmail = '';

    function b64urlToUint8Array(base64url) {
        const padding = '='.repeat((4 - (base64url.length % 4)) % 4);
        const base64 = (base64url + padding).replace(/-/g, '+').replace(/_/g, '/');
        const raw = window.atob(base64);
        const out = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) {
            out[i] = raw.charCodeAt(i);
        }
        return out;
    }

    function bufferToB64url(buffer) {
        const bytes = new Uint8Array(buffer);
        let bin = '';
        for (let i = 0; i < bytes.byteLength; i++) {
            bin += String.fromCharCode(bytes[i]);
        }
        return window.btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    function showAuthScreen() {
        state.user = null;
        lastHistoryState = null;
        $('#app-shell').classList.add('hidden');
        $('#auth-screen').classList.remove('hidden');
        $('#setup-card')?.classList.add('hidden');
        $('#twofactor-card')?.classList.add('hidden');
        $('#login-card')?.classList.remove('hidden');
    }

    function enterAppShell() {
        $('#auth-screen').classList.add('hidden');
        $('#twofactor-card')?.classList.add('hidden');
        $('#app-shell').classList.remove('hidden');
        updateUserSidebar();
        initBrowserHistory();
        loadCurrentView();
    }

    function showTwoFactorCard(res) {
        const methods = res.methods || ['totp'];
        active2faMethod = res.default_method || methods[0] || 'totp';
        pending2faMaskedEmail = res.masked_email || '';

        $('#login-card').classList.add('hidden');
        $('#twofactor-card').classList.remove('hidden');
        $('#twofactor-error').classList.add('hidden');

        const tabsWrap = $('#twofactor-method-tabs');
        const labels = {
            totp: '📱 Authenticator',
            passkey: '🔑 Biometrie',
            email: '✉️ E-Mail',
        };
        tabsWrap.innerHTML = methods.map((m) => `
            <button type="button" class="tab-btn ${m === active2faMethod ? 'active' : ''}" data-2fa-m="${m}">
                ${labels[m] || m}
            </button>
        `).join('');

        $$('[data-2fa-m]', tabsWrap).forEach((btn) => {
            btn.addEventListener('click', () => {
                active2faMethod = btn.getAttribute('data-2fa-m') || 'totp';
                $$('[data-2fa-m]', tabsWrap).forEach((b) => b.classList.toggle('active', b === btn));
                updateTwoFactorMethodUI();
            });
        });

        updateTwoFactorMethodUI();
    }

    function updateTwoFactorMethodUI() {
        const isPasskey = active2faMethod === 'passkey';
        const isEmail = active2faMethod === 'email';

        $('#twofactor-code-form').classList.toggle('hidden', isPasskey);
        $('#twofactor-passkey-box').classList.toggle('hidden', !isPasskey);
        $('#btn-resend-email-2fa').classList.toggle('hidden', !isEmail);

        if (isPasskey) {
            $('#twofactor-subtitle').textContent = 'Bestätigen Sie Ihre Identität per Fingerabdruck, FaceID oder Sicherheitsschlüssel.';
        } else if (isEmail) {
            $('#twofactor-subtitle').textContent = pending2faMaskedEmail
                ? `Geben Sie den 6-stelligen Code ein, der an ${pending2faMaskedEmail} gesendet wurde.`
                : 'Fordern Sie einen 6-stelligen Einmalcode per E-Mail an.';
            $('#twofactor-code-label').textContent = '6-stelliger E-Mail-Code';
            $('#twofactor-code-input').value = '';
            $('#twofactor-code-input').focus();
        } else {
            $('#twofactor-subtitle').textContent = 'Geben Sie den 6-stelligen Code aus Ihrer Authenticator-App ein.';
            $('#twofactor-code-label').textContent = '6-stelliger Authenticator-Code (TOTP)';
            $('#twofactor-code-input').value = '';
            $('#twofactor-code-input').focus();
        }
    }

    function updateUserSidebar() {
        if (!state.user) return;
        $('#user-display-name').textContent = state.user.display_name || state.user.username;
        $('#user-role-badge').textContent = state.user.role === 'admin' ? 'Administrator' : 'Benutzer';
        $('#user-avatar').textContent = (state.user.display_name || state.user.username || 'U').charAt(0).toUpperCase();
        $('#btn-admin-modal')?.classList.toggle('hidden', state.user.role !== 'admin');
        updateQuotaBar(state.user.used_bytes, state.user.quota_bytes);
    }

    function updateQuotaBar(usedBytes, quotaBytes) {
        const used = Number(usedBytes) || 0;
        const quota = Number(quotaBytes) || 0;
        if (quota <= 0) {
            $('#quota-text').textContent = `${formatBytes(used)} / ∞`;
            $('#quota-fill').style.width = '8%';
        } else {
            const pct = Math.min(100, Math.round((used / quota) * 100));
            $('#quota-text').textContent = `${formatBytes(used)} / ${formatBytes(quota)}`;
            $('#quota-fill').style.width = `${pct}%`;
            $('#quota-fill').style.background = pct > 90 ? 'var(--danger)' : 'var(--primary)';
        }
    }

    // Setup Form
    $('#setup-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const errBox = $('#setup-error');
        errBox.classList.add('hidden');
        try {
            const res = await apiPost('setup_admin', Object.fromEntries(fd.entries()));
            state.user = res.user;
            state.csrfToken = res.csrf_token;
            enterAppShell();
            toast('Willkommen! Ihr Administrator-Konto wurde eingerichtet.');
        } catch (err) {
            errBox.textContent = err.message;
            errBox.classList.remove('hidden');
        }
    });

    // Login Form
    $('#login-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const errBox = $('#login-error');
        errBox.classList.add('hidden');
        try {
            const res = await apiPost('login', Object.fromEntries(fd.entries()));
            if (res.two_factor_required) {
                showTwoFactorCard(res);
                return;
            }
            state.user = res.user;
            state.csrfToken = res.csrf_token;
            e.target.reset();
            enterAppShell();
        } catch (err) {
            errBox.textContent = err.message;
            errBox.classList.remove('hidden');
        }
    });

    // 2FA Verification Form (TOTP / Email)
    $('#twofactor-code-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const errBox = $('#twofactor-error');
        errBox.classList.add('hidden');
        try {
            const code = $('#twofactor-code-input').value.trim();
            const res = await apiPost('verify_2fa', { method: active2faMethod, code });
            state.user = res.user;
            state.csrfToken = res.csrf_token;
            $('#login-form')?.reset();
            enterAppShell();
        } catch (err) {
            errBox.textContent = err.message;
            errBox.classList.remove('hidden');
        }
    });

    $('#btn-resend-email-2fa')?.addEventListener('click', async () => {
        try {
            const res = await apiPost('send_email_2fa');
            pending2faMaskedEmail = res.masked_email || pending2faMaskedEmail;
            updateTwoFactorMethodUI();
            toast(`Neuer Sicherheitscode an ${pending2faMaskedEmail} gesendet.`);
        } catch (err) {
            toast(err.message, 'error');
        }
    });

    $('#btn-cancel-2fa')?.addEventListener('click', () => {
        showAuthScreen();
    });

    // Biometric / Passkey Login (Direct or as 2FA step)
    async function executePasskeyLogin(usernameHint = '') {
        if (!window.PublicKeyCredential) {
            throw new Error('Ihr Browser oder Gerät unterstützt keine WebAuthn-Biometrie / Passkeys.');
        }
        const opts = await apiPost('passkey_login_options', { username: usernameHint });
        const publicKey = {
            challenge: b64urlToUint8Array(opts.challengeB64),
            rpId: opts.rpId,
            userVerification: 'preferred',
            timeout: 60000,
        };
        if (opts.allowCredentials && opts.allowCredentials.length > 0) {
            publicKey.allowCredentials = opts.allowCredentials.map((c) => ({
                type: 'public-key',
                id: b64urlToUint8Array(c.id),
            }));
        }

        const assertion = await navigator.credentials.get({ publicKey });
        if (!assertion) {
            throw new Error('Biometrie-Anmeldung abgebrochen.');
        }

        const res = await apiPost('passkey_login_verify', {
            credential_id: bufferToB64url(assertion.rawId),
            client_data_json: bufferToB64url(assertion.response.clientDataJSON),
            authenticator_data: bufferToB64url(assertion.response.authenticatorData),
            signature: bufferToB64url(assertion.response.signature),
            remember: !!$('#login-remember-chk')?.checked,
        });

        state.user = res.user;
        state.csrfToken = res.csrf_token;
        $('#login-form')?.reset();
        enterAppShell();
        toast('Per Biometrie / Passkey angemeldet!');
    }

    $('#btn-passkey-direct-login')?.addEventListener('click', async () => {
        const errBox = $('#login-error');
        errBox.classList.add('hidden');
        try {
            const uname = $('#login-username-input')?.value.trim() || '';
            await executePasskeyLogin(uname);
        } catch (err) {
            errBox.textContent = err.message;
            errBox.classList.remove('hidden');
        }
    });

    $('#btn-verify-passkey-2fa')?.addEventListener('click', async () => {
        const errBox = $('#twofactor-error');
        errBox.classList.add('hidden');
        try {
            await executePasskeyLogin('');
        } catch (err) {
            errBox.textContent = err.message;
            errBox.classList.remove('hidden');
        }
    });

    // Logout
    $('#btn-logout')?.addEventListener('click', async () => {
        try {
            await apiPost('logout');
        } catch (_) {}
        showAuthScreen();
    });

    // Theme Toggle
    $('#btn-theme-toggle')?.addEventListener('click', () => {
        state.theme = state.theme === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', state.theme);
        localStorage.setItem('cloud_theme', state.theme);
    });

    // Mobile Sidebar Toggle & Close
    function setMobileSidebarOpen(open) {
        $('#sidebar')?.classList.toggle('open', open);
        $('#sidebar-backdrop')?.classList.toggle('hidden', !open);
    }

    $('#btn-mobile-sidebar')?.addEventListener('click', () => {
        const isOpen = $('#sidebar')?.classList.contains('open');
        setMobileSidebarOpen(!isOpen);
    });

    $('#btn-close-sidebar')?.addEventListener('click', () => setMobileSidebarOpen(false));
    $('#sidebar-backdrop')?.addEventListener('click', () => setMobileSidebarOpen(false));

    // Layout Toggle (List vs Grid vs Split)
    function updateLayoutButtons() {
        $('#btn-layout-list').classList.toggle('active', state.layout === 'list');
        $('#btn-layout-grid').classList.toggle('active', state.layout === 'grid');
        $('#btn-layout-split')?.classList.toggle('active', state.layout === 'split');
    }
    updateLayoutButtons();

    $('#btn-layout-list')?.addEventListener('click', () => {
        state.layout = 'list';
        localStorage.setItem('cloud_layout', 'list');
        updateLayoutButtons();
        loadCurrentView();
    });

    $('#btn-layout-grid')?.addEventListener('click', () => {
        state.layout = 'grid';
        localStorage.setItem('cloud_layout', 'grid');
        updateLayoutButtons();
        loadCurrentView();
    });

    $('#btn-layout-split')?.addEventListener('click', () => {
        state.layout = 'split';
        localStorage.setItem('cloud_layout', 'split');
        if (state.view !== 'files') {
            state.view = 'files';
            $$('.sidebar-nav .nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === 'files'));
        }
        updateLayoutButtons();
        loadCurrentView();
    });

    function setActiveNavView(viewName) {
        $$('.sidebar-nav .nav-item').forEach((b) => {
            b.classList.toggle('active', (b.dataset.view || 'files') === viewName);
        });
    }

    // Sidebar Navigation & Drag-and-Drop Targets (Tresor, Papierkorb, Hauptordner)
    $$('.sidebar-nav .nav-item').forEach((btn) => {
        const navView = btn.dataset.view || 'files';

        btn.addEventListener('click', () => {
            setActiveNavView(navView);
            state.view = navView;
            state.currentFolderId = null;
            state.search = '';
            $('#search-input').value = '';
            setMobileSidebarOpen(false);
            loadCurrentView();
        });

        if (['vault', 'trash', 'files', 'favorites'].includes(navView)) {
            btn.addEventListener('dragover', (e) => {
                if (e.dataTransfer.types.includes('application/x-cloud-item')) {
                    e.preventDefault();
                    btn.classList.add('drag-over');
                }
            });
            btn.addEventListener('dragleave', () => btn.classList.remove('drag-over'));
            btn.addEventListener('drop', async (e) => {
                btn.classList.remove('drag-over');
                const raw = e.dataTransfer.getData('application/x-cloud-item');
                if (!raw) return;
                e.preventDefault();
                e.stopPropagation();

                const items = JSON.parse(raw);
                if (!items || items.length === 0) return;

                if (navView === 'vault') {
                    openBatchVaultModal(items);
                } else if (navView === 'favorites') {
                    try {
                        for (const it of items) {
                            await apiPost('toggle_favorite', { type: it.type, id: it.id });
                        }
                        toast(`${items.length} Element(e) zu Favoriten hinzugefügt.`);
                        loadCurrentView();
                    } catch (err) {
                        toast(err.message, 'error');
                    }
                } else if (navView === 'trash') {
                    try {
                        const res = await apiPost('trash', { items });
                        toast(`${res.count} Element(e) in den Papierkorb verschoben.`);
                        loadCurrentView();
                    } catch (err) {
                        toast(err.message, 'error');
                    }
                } else if (navView === 'files') {
                    try {
                        const res = await apiPost('move', { items, target_folder_id: null });
                        toast(`${res.moved} Element(e) in den Hauptordner verschoben.`);
                        loadCurrentView();
                    } catch (err) {
                        toast(err.message, 'error');
                    }
                }
            });
        }
    });

    function openBatchVaultModal(items) {
        if (items.length === 1 && items[0].type === 'folder') {
            openVaultModal({ type: 'folder', id: items[0].id, name: items[0].name });
            return;
        }
        const namesList = items.slice(0, 5).map((x) => `${x.type === 'folder' ? '📁' : '📄'} ${esc(x.name)}`).join('<br>');
        const moreText = items.length > 5 ? `<br><span class="muted">… und ${items.length - 5} weitere</span>` : '';

        openModal(`🔒 Im Tresor verschlüsseln (${items.length} Element${items.length > 1 ? 'e' : ''})`, `
            <p class="muted small" style="margin-top:0">
                Folgende Elemente (inkl. etwaiger Unterordner) werden mit <strong>AES-256-GCM</strong> (Zero-Knowledge) verschlüsselt:
            </p>
            <div class="code-box small" style="margin-bottom:0.9rem">${namesList}${moreText}</div>
            <form id="batch-vault-form">
                <div class="form-group">
                    <label>Tresor-Passwort festlegen (mind. 4 Zeichen)</label>
                    <input type="password" name="password" class="input" placeholder="Tresor-Passwort…" required minlength="4">
                </div>
                <div class="form-group">
                    <label>Passwort wiederholen</label>
                    <input type="password" name="password2" class="input" placeholder="Passwort bestätigen…" required minlength="4">
                </div>
                <button type="submit" class="btn btn-primary btn-block">🔒 Jetzt im Tresor verschlüsseln</button>
            </form>
        `);
        $('#batch-vault-form')?.querySelector('input')?.focus();
        $('#batch-vault-form')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const pw1 = e.target.password.value;
            const pw2 = e.target.password2.value;
            if (pw1 !== pw2) {
                toast('Die Passwörter stimmen nicht überein.', 'error');
                return;
            }
            const btn = e.target.querySelector('button[type="submit"]');
            btn.disabled = true;
            btn.textContent = 'Verschlüssele…';
            try {
                const res = await apiPost('vault_encrypt_items', { items, password: pw1 });
                closeModal();
                toast(`${res.encrypted_count} Datei(en) erfolgreich im Tresor verschlüsselt!`);
                loadCurrentView();
            } catch (err) {
                toast(err.message, 'error');
                btn.disabled = false;
                btn.textContent = '🔒 Jetzt im Tresor verschlüsseln';
            }
        });
    }

    // Search Input (Debounced)
    let searchTimer = null;
    $('#search-input')?.addEventListener('input', (e) => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
            state.search = e.target.value.trim();
            if (state.view === 'my_shares') {
                state.view = 'files';
                $$('.sidebar-nav .nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === 'files'));
            }
            loadCurrentView();
        }, 250);
    });

    // Main View Loader
    async function loadCurrentView() {
        state.selected.clear();
        updateBulkToolbar();

        if (state.view === 'my_shares') {
            await loadMySharesView();
            return;
        }

        try {
            const params = {
                action: 'list',
                view: state.view,
            };
            if (state.currentFolderId !== null) {
                params.folder_id = state.currentFolderId;
            }
            if (state.search !== '') {
                params.search = state.search;
            }

            const isSplit = state.layout === 'split' && state.view === 'files' && state.search === '';
            const rightPromise = isSplit
                ? apiGet({
                    action: 'list',
                    view: 'files',
                    ...(state.rightFolderId !== null ? { folder_id: state.rightFolderId } : {}),
                }).catch(() => {
                    state.rightFolderId = null;
                    return apiGet({ action: 'list', view: 'files' });
                })
                : Promise.resolve(null);

            const [res, rightRes] = await Promise.all([apiGet(params), rightPromise]);
            const data = res.data;
            state.permission = data.permission || 'owner';
            state.isGroupTree = Boolean(data.is_group_tree);
            state.breadcrumbs = data.breadcrumbs || [];
            state.folders = data.folders || [];
            state.files = data.files || [];

            if (rightRes && rightRes.data) {
                state.rightBreadcrumbs = rightRes.data.breadcrumbs || [];
                state.rightFolders = rightRes.data.folders || [];
                state.rightFiles = rightRes.data.files || [];
            }

            if (res.user) {
                state.user.used_bytes = res.user.used_bytes;
                state.user.quota_bytes = res.user.quota_bytes;
                updateQuotaBar(res.user.used_bytes, res.user.quota_bytes);
            }

            const canWriteHere = (state.view === 'files' || (state.view === 'shared' && state.currentFolderId !== null))
                && ['owner', 'write'].includes(state.permission)
                && state.search === '';

            $('#folder-write-actions').classList.toggle('hidden', !canWriteHere);
            $('#trash-toolbar').classList.toggle('hidden', state.view !== 'trash' || (state.folders.length === 0 && state.files.length === 0));

            renderBreadcrumbs();
            renderItems();
            pushNavigationState();
        } catch (err) {
            toast(err.message, 'error');
        }
    }

    function renderBreadcrumbs() {
        const nav = $('#breadcrumbs');
        nav.innerHTML = '';
        state.breadcrumbs.forEach((crumb, idx) => {
            if (idx > 0) {
                const sep = document.createElement('span');
                sep.className = 'crumb-sep';
                sep.textContent = '/';
                nav.appendChild(sep);
            }
            const span = document.createElement('span');
            span.className = 'crumb' + (idx === state.breadcrumbs.length - 1 ? ' active' : '');
            span.dataset.crumbId = crumb.id === null ? '' : String(crumb.id);
            span.dataset.crumbName = crumb.name;
            span.textContent = crumb.name;
            span.addEventListener('click', () => {
                state.currentFolderId = crumb.id;
                state.search = '';
                $('#search-input').value = '';
                loadCurrentView();
            });

            // Allow dropping items onto a breadcrumb to move them up!
            if (state.view === 'files') {
                span.addEventListener('dragover', (e) => {
                    if (e.dataTransfer.types.includes('application/x-cloud-item')) {
                        e.preventDefault();
                        span.classList.add('drag-over');
                    }
                });
                span.addEventListener('dragleave', () => span.classList.remove('drag-over'));
                span.addEventListener('drop', async (e) => {
                    span.classList.remove('drag-over');
                    const raw = e.dataTransfer.getData('application/x-cloud-item');
                    if (!raw) return;
                    e.preventDefault();
                    try {
                        const items = JSON.parse(raw);
                        await apiPost('move', { items, target_folder_id: crumb.id });
                        toast('Verschoben.');
                        loadCurrentView();
                    } catch (err) {
                        toast(err.message, 'error');
                    }
                });
            }

            nav.appendChild(span);
        });
    }

    function fileIcon(file) {
        if (file.is_encrypted) return '🔒';
        switch (file.category) {
            case 'image': return '🖼️';
            case 'video': return '🎬';
            case 'audio': return '🎵';
            case 'pdf':   return '📕';
            case 'zip':   return '📦';
            case 'text':  return '📝';
            default:      return '📄';
        }
    }

    function filterLabel(ft) {
        switch (ft) {
            case 'favorite':   return '⭐ Favoriten';
            case 'has_tag':    return '🎨 Mit Tag';
            case 'tag_red':    return '🔴 Tag: Rot';
            case 'tag_orange': return '🟠 Tag: Orange';
            case 'tag_yellow': return '🟡 Tag: Gelb';
            case 'tag_green':  return '🟢 Tag: Grün';
            case 'tag_blue':   return '🔵 Tag: Blau';
            case 'tag_purple': return '🟣 Tag: Lila';
            case 'has_note':   return '📝 Mit Notiz';
            case 'folder':     return '📁 Ordner';
            case 'doc':        return '📄 Dokumente';
            case 'image':      return '🖼️ Bilder';
            case 'video':      return '🎬 Videos';
            case 'audio':      return '🎵 Audio';
            case 'zip':        return '📦 ZIP';
            case 'encrypted':  return '🔒 Tresor';
            case 'shared':     return '🔗 Geteilt';
            default:           return 'Filter';
        }
    }

    function activeFilterSummary() {
        const ft = state.filterType || 'all';
        const q = (state.filterText || '').trim();
        if (ft !== 'all' && q !== '') {
            return `${filterLabel(ft)} · „${q}“`;
        }
        if (q !== '') {
            return `🔍 „${q}“`;
        }
        return filterLabel(ft);
    }

    function hasActiveFilter() {
        return (state.filterType && state.filterType !== 'all') || (state.filterText || '').trim() !== '';
    }

    function filterAndSortItems(folders, files) {
        const ft = state.filterType || 'all';
        const q = (state.filterText || '').trim().toLowerCase();
        const matchItem = (it) => {
            if (q !== '' && !String(it.name || '').toLowerCase().includes(q)) {
                return false;
            }
            if (ft === 'all') return true;
            if (ft === 'favorite') return Boolean(it.is_favorite);
            if (ft === 'has_tag') return Boolean(it.color_tag);
            if (ft.startsWith('tag_')) return it.color_tag === ft.slice(4);
            if (ft === 'has_note') return Boolean(it.notes && it.notes.trim() !== '');
            if (ft === 'folder') return it.type === 'folder';
            if (ft === 'encrypted') return Boolean(it.is_encrypted || it.encrypted_count > 0);
            if (ft === 'shared') return Boolean(it.share_count > 0 || it.group_name);
            if (it.type === 'folder') return false;
            if (ft === 'doc') return ['pdf', 'text', 'other'].includes(it.category);
            return it.category === ft;
        };

        const dir = state.sortDir === 'desc' ? -1 : 1;
        const cmp = (a, b) => {
            if (a.is_group_root && !b.is_group_root) return -1;
            if (!a.is_group_root && b.is_group_root) return 1;
            if (state.sortBy === 'size' && a.type === 'file' && b.type === 'file') {
                const diff = (Number(a.size_bytes || 0) - Number(b.size_bytes || 0)) * dir;
                if (diff !== 0) return diff;
            } else if (state.sortBy === 'date') {
                const da = String(a.updated_at || '');
                const db = String(b.updated_at || '');
                const diff = da.localeCompare(db) * dir;
                if (diff !== 0) return diff;
            } else if (state.sortBy === 'tag') {
                const ta = String(a.color_tag || '');
                const tb = String(b.color_tag || '');
                if (ta !== '' && tb === '') return -1 * dir;
                if (ta === '' && tb !== '') return 1 * dir;
                const diff = ta.localeCompare(tb) * dir;
                if (diff !== 0) return diff;
            }
            return String(a.name || '').localeCompare(String(b.name || ''), 'de', { numeric: true, sensitivity: 'base' }) * dir;
        };

        const sortedFolders = folders.filter(matchItem).slice().sort(cmp);
        const sortedFiles = files.filter(matchItem).slice().sort(cmp);
        return [...sortedFolders, ...sortedFiles];
    }

    function renderItems() {
        const container = $('#items-container');
        if (state.layout === 'split' && state.view === 'files' && state.search === '') {
            renderSplitView(container);
            return;
        }

        const rawTotal = state.folders.length + state.files.length;
        const allItems = filterAndSortItems(state.folders, state.files);

        if (rawTotal === 0) {
            const emptyMsg = state.view === 'trash'
                ? 'Der Papierkorb ist leer.'
                : state.view === 'vault'
                    ? 'Keine verschlüsselten Dateien im Tresor. Sie können jede Datei über das 🔒-Symbol mit AES-256 verschlüsseln.'
                    : state.view === 'favorites'
                        ? 'Keine Favoriten vorhanden. Klicken Sie bei beliebigen Ordnern oder Dateien auf das Stern-Symbol (⭐), um sie hier schnell griffbereit zu haben.'
                        : state.view === 'shared'
                            ? 'Noch keine Dateien oder Ordner für Sie freigegeben.'
                            : 'Dieser Ordner ist leer. Ziehen Sie Dateien oder ganze Ordner per Drag & Drop hierher!';
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-icon">${state.view === 'trash' ? '🗑️' : state.view === 'vault' ? '🔒' : state.view === 'favorites' ? '⭐' : '📂'}</div>
                    <h3>Keine Einträge</h3>
                    <p class="muted">${esc(emptyMsg)}</p>
                </div>
            `;
            return;
        }

        if (state.layout === 'grid') {
            renderGridView(container, allItems);
        } else {
            renderListView(container, allItems);
        }
    }

    function renderSplitView(container) {
        const leftItems = filterAndSortItems(state.folders, state.files);
        const rightItems = filterAndSortItems(state.rightFolders, state.rightFiles);

        const renderPaneCrumbs = (crumbs, side) => crumbs.map((c, idx) => `
            ${idx > 0 ? '<span class="crumb-sep">/</span>' : ''}
            <span class="crumb ${idx === crumbs.length - 1 ? 'active' : ''}" data-split-crumb="${side}" data-folder-id="${c.id ?? ''}">${esc(c.name)}</span>
        `).join('');

        const renderPaneRows = (items, side) => {
            if (items.length === 0) {
                return `<tr><td colspan="3" class="empty-cell">Ordner ist leer – Dateien hierher ziehen</td></tr>`;
            }
            return items.map((item) => {
                const key = `${item.type}:${item.id}`;
                const isSel = state.selected.has(key);
                const isFolder = item.type === 'folder';
                const hasThumb = !isFolder && item.category === 'image' && !item.is_encrypted;
                return `
                    <tr data-split-side="${side}" data-key="${key}" data-type="${item.type}" data-id="${item.id}" draggable="${!item.is_group_folder}" class="${isSel ? 'selected' : ''}">
                        <td style="width:32px">
                            <input type="checkbox" class="row-chk" data-side="${side}" data-key="${key}" ${isSel ? 'checked' : ''}>
                        </td>
                        <td>
                            <div class="item-cell" data-split-open="${key}" data-side="${side}" style="min-width:140px">
                                ${hasThumb
                                    ? `<img class="item-thumb" loading="lazy" src="api.php?action=thumb&id=${item.id}" alt="">`
                                    : `<div class="item-icon">${isFolder ? '📁' : fileIcon(item)}</div>`
                                }
                                <div class="item-name-wrap">
                                    <span class="item-name">${esc(item.name)}</span>
                                    ${item.is_encrypted || item.encrypted_count > 0 ? '<span class="badge badge-vault">🔒</span>' : ''}
                                    ${item.share_count > 0 ? '<span class="badge badge-shared">🔗</span>' : ''}
                                    ${item.group_name ? `<span class="badge badge-shared" title="Gruppenordner">👪 ${esc(item.group_name)}</span>` : ''}
                                </div>
                            </div>
                        </td>
                        <td class="muted small" style="width:90px;text-align:right;white-space:nowrap">${isFolder ? '—' : formatBytes(item.size_bytes)}</td>
                    </tr>
                `;
            }).join('');
        };

        container.innerHTML = `
            <div class="split-workspace">
                <!-- Pane 1 -->
                <section class="split-pane" data-pane-side="left" data-pane-folder="${state.currentFolderId ?? ''}">
                    <header class="split-pane-header">
                        <div class="split-pane-crumbs">${renderPaneCrumbs(state.breadcrumbs, 'left')}</div>
                        <button type="button" class="btn btn-ghost btn-sm" data-split-new-folder="left" title="Neuer Ordner">➕ Ordner</button>
                    </header>
                    <div class="file-table-wrap">
                        <table class="file-table">
                            <thead>
                                <tr>
                                    <th style="width:32px"></th>
                                    <th>Name</th>
                                    <th style="text-align:right">Größe</th>
                                </tr>
                            </thead>
                            <tbody>${renderPaneRows(leftItems, 'left')}</tbody>
                        </table>
                    </div>
                </section>

                <!-- Pane 2 -->
                <section class="split-pane" data-pane-side="right" data-pane-folder="${state.rightFolderId ?? ''}">
                    <header class="split-pane-header">
                        <div class="split-pane-crumbs">${renderPaneCrumbs(state.rightBreadcrumbs, 'right')}</div>
                        <button type="button" class="btn btn-ghost btn-sm" data-split-new-folder="right" title="Neuer Ordner">➕ Ordner</button>
                    </header>
                    <div class="file-table-wrap">
                        <table class="file-table">
                            <thead>
                                <tr>
                                    <th style="width:32px"></th>
                                    <th>Name</th>
                                    <th style="text-align:right">Größe</th>
                                </tr>
                            </thead>
                            <tbody>${renderPaneRows(rightItems, 'right')}</tbody>
                        </table>
                    </div>
                </section>
            </div>
        `;

        bindSplitViewEvents(container, leftItems, rightItems);
    }

    function bindSplitViewEvents(container, leftItems, rightItems) {
        const itemMap = new Map([...leftItems, ...rightItems].map((it) => [`${it.type}:${it.id}`, it]));

        async function executeSplitTransfer(items, targetFolderId, forceCopy = false) {
            if (!items || items.length === 0) {
                toast('Bitte zuerst Dateien oder Ordner auswählen.', 'error');
                return;
            }
            const action = forceCopy ? 'copy' : 'move';
            try {
                const res = await apiPost(action, { items, target_folder_id: targetFolderId });
                const count = action === 'copy' ? res.copied : res.moved;
                toast(`${count} Element(e) ${action === 'copy' ? 'kopiert' : 'verschoben'}.`);
                loadCurrentView();
            } catch (err) {
                toast(err.message, 'error');
            }
        }

        // Breadcrumb clicks & drop targets in both panes
        $$('[data-split-crumb]', container).forEach((el) => {
            const side = el.dataset.splitCrumb;
            const rawId = el.dataset.folderId;
            const folderId = rawId === '' ? null : Number(rawId);

            el.addEventListener('click', () => {
                if (side === 'left') {
                    state.currentFolderId = folderId;
                } else {
                    state.rightFolderId = folderId;
                }
                loadCurrentView();
            });

            el.addEventListener('dragover', (e) => {
                if (e.dataTransfer.types.includes('application/x-cloud-item')) {
                    e.preventDefault();
                    el.classList.add('drag-over');
                }
            });
            el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
            el.addEventListener('drop', async (e) => {
                el.classList.remove('drag-over');
                const raw = e.dataTransfer.getData('application/x-cloud-item');
                if (!raw) return;
                e.preventDefault();
                e.stopPropagation();
                await executeSplitTransfer(JSON.parse(raw), folderId, e.ctrlKey || e.altKey || e.metaKey);
            });
        });

        // New folder button per pane
        $$('[data-split-new-folder]', container).forEach((btn) => {
            btn.addEventListener('click', () => {
                const side = btn.dataset.splitNewFolder;
                const parentId = side === 'left' ? state.currentFolderId : state.rightFolderId;
                openModal(`Neuer Ordner (${side === 'left' ? 'Linkes Fenster' : 'Rechtes Fenster'})`, `
                    <form id="split-new-folder-form">
                        <div class="form-group">
                            <label>Ordnername</label>
                            <input type="text" name="name" class="input" placeholder="Ordnername…" required>
                        </div>
                        <button type="submit" class="btn btn-primary btn-block">Ordner erstellen</button>
                    </form>
                `);
                $('#split-new-folder-form').querySelector('input').focus();
                $('#split-new-folder-form').addEventListener('submit', async (e) => {
                    e.preventDefault();
                    const name = e.target.name.value.trim();
                    try {
                        await apiPost('create_folder', { parent_id: parentId, name });
                        closeModal();
                        toast(`Ordner "${name}" erstellt.`);
                        loadCurrentView();
                    } catch (err) {
                        toast(err.message, 'error');
                    }
                });
            });
        });

        // Checkboxes
        $$('.row-chk', container).forEach((chk) => {
            chk.addEventListener('click', (e) => e.stopPropagation());
            chk.addEventListener('change', () => {
                const key = chk.dataset.key;
                const it = itemMap.get(key);
                if (!it) return;
                if (chk.checked) {
                    state.selected.set(key, it);
                } else {
                    state.selected.delete(key);
                }
                $$(`[data-key="${key}"]`, container).forEach((r) => r.classList.toggle('selected', chk.checked));
                updateBulkToolbar();
            });
        });

        // Open folder in the respective pane or open file modal
        $$('[data-split-open]', container).forEach((el) => {
            el.addEventListener('click', (e) => {
                if (el.closest('[data-key]')?.dataset.longPressed === '1') {
                    el.closest('[data-key]').dataset.longPressed = '0';
                    e.preventDefault();
                    return;
                }
                const item = itemMap.get(el.dataset.splitOpen);
                const side = el.dataset.side;
                if (!item) return;
                if (item.type === 'folder') {
                    if (side === 'left') {
                        state.currentFolderId = item.id;
                    } else {
                        state.rightFolderId = item.id;
                    }
                    loadCurrentView();
                } else {
                    openFileModal(item);
                }
            });
        });

        // Drag start, context menu (right-click & long-touch) & folder row drop targets
        $$('tr[data-key]', container).forEach((row) => {
            const key = row.dataset.key;
            const item = itemMap.get(key);
            if (!item) return;

            bindContextMenuEvents(row, item, row.dataset.splitSide || 'left');

            row.addEventListener('dragstart', (e) => {
                let dragList = [{ type: item.type, id: item.id, name: item.name }];
                if (state.selected.has(key)) {
                    dragList = Array.from(state.selected.values()).map((x) => ({ type: x.type, id: x.id, name: x.name }));
                }
                e.dataTransfer.setData('application/x-cloud-item', JSON.stringify(dragList));
                e.dataTransfer.effectAllowed = 'copyMove';
            });

            if (item.type === 'folder') {
                row.addEventListener('dragover', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    row.classList.add('drag-over');
                    const lbl = $('#drop-target-label');
                    if (lbl) lbl.textContent = `In Ordner „${item.name}“ ablegen`;
                });
                row.addEventListener('dragleave', () => {
                    row.classList.remove('drag-over');
                    const lbl = $('#drop-target-label');
                    if (lbl) lbl.textContent = 'Dateien hier ablegen (oder direkt auf einen Ordner ziehen)';
                });
                row.addEventListener('drop', async (e) => {
                    row.classList.remove('drag-over');
                    const raw = e.dataTransfer.getData('application/x-cloud-item');
                    if (raw) {
                        e.preventDefault();
                        e.stopPropagation();
                        await executeSplitTransfer(JSON.parse(raw), item.id, e.ctrlKey || e.altKey || e.metaKey);
                        return;
                    }
                    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                        e.preventDefault();
                        e.stopPropagation();
                        const entries = await extractDroppedFileEntries(e.dataTransfer);
                        await uploadFileEntries(entries, item.id);
                    }
                });
            }
        });

        // Dropping anywhere onto Left Pane or Right Pane
        $$('.split-pane', container).forEach((pane) => {
            const rawFolder = pane.dataset.paneFolder;
            const paneFolderId = rawFolder === '' ? null : Number(rawFolder);

            pane.addEventListener('dragover', (e) => {
                if (e.dataTransfer.types.includes('application/x-cloud-item') || e.dataTransfer.types.includes('Files')) {
                    e.preventDefault();
                    pane.classList.add('pane-drop-target');
                }
            });
            pane.addEventListener('dragleave', (e) => {
                if (!pane.contains(e.relatedTarget)) {
                    pane.classList.remove('pane-drop-target');
                }
            });
            pane.addEventListener('drop', async (e) => {
                pane.classList.remove('pane-drop-target');
                const raw = e.dataTransfer.getData('application/x-cloud-item');
                if (raw) {
                    e.preventDefault();
                    e.stopPropagation();
                    await executeSplitTransfer(JSON.parse(raw), paneFolderId, e.ctrlKey || e.altKey || e.metaKey);
                    return;
                }
                if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                    e.preventDefault();
                    e.stopPropagation();
                    const entries = await extractDroppedFileEntries(e.dataTransfer);
                    await uploadFileEntries(entries, paneFolderId);
                }
            });
        });
    }

    function renderListView(container, allItems) {
        const isTrash = state.view === 'trash';
        const arrow = (col) => state.sortBy === col ? `<span class="th-sort-arrow">${state.sortDir === 'asc' ? '▲' : '▼'}</span>` : '';
        const isFiltered = hasActiveFilter();
        const filterOpts = [
            { id: 'all',        label: '✦ Alle Typen' },
            { id: 'favorite',   label: '⭐ Nur Favoriten' },
            { id: 'has_tag',    label: '🎨 Mit Farb-Tag' },
            { id: 'tag_red',    label: '🔴 Tag: Rot' },
            { id: 'tag_orange', label: '🟠 Tag: Orange' },
            { id: 'tag_yellow', label: '🟡 Tag: Gelb' },
            { id: 'tag_green',  label: '🟢 Tag: Grün' },
            { id: 'tag_blue',   label: '🔵 Tag: Blau' },
            { id: 'tag_purple', label: '🟣 Tag: Lila' },
            { id: 'has_note',   label: '📝 Mit Notiz' },
            { id: 'folder',     label: '📁 Nur Ordner' },
            { id: 'doc',        label: '📄 Dokumente & PDF' },
            { id: 'image',      label: '🖼️ Bilder' },
            { id: 'video',      label: '🎬 Videos' },
            { id: 'audio',      label: '🎵 Audio' },
            { id: 'zip',        label: '📦 ZIP-Archive' },
            { id: 'encrypted',  label: '🔒 Verschlüsselt (Tresor)' },
            { id: 'shared',     label: '🔗 Geteilt / Gruppenordner' },
        ];
        const filterMenuHtml = `
            <div style="padding:0.25rem 0.25rem 0.45rem;border-bottom:1px solid var(--border);margin-bottom:0.25rem">
                <input type="text" id="th-filter-text-inp" class="input small" placeholder="🔍 Dateiname enthält…" value="${esc(state.filterText)}" autocomplete="off" style="padding:0.35rem 0.55rem;font-size:0.82rem">
            </div>
        ` + filterOpts.map((o) => `
            <button type="button" class="dropdown-item ${state.filterType === o.id ? 'active' : ''}" data-filter-opt="${o.id}">
                ${o.label}
            </button>
        `).join('');

        const colorTagNames = {
            red: 'Rot',
            orange: 'Orange',
            yellow: 'Gelb',
            green: 'Grün',
            blue: 'Blau',
            purple: 'Lila',
        };

        let html = `
            <div class="file-table-wrap">
                <table class="file-table">
                    <thead>
                        <tr>
                            <th style="width:36px"><input type="checkbox" id="select-all-chk"></th>
                            <th>
                                <div class="th-sort-wrap">
                                    <span class="th-sort-btn ${state.sortBy === 'name' ? 'active' : ''}" data-sort-col="name" title="Nach Name sortieren">
                                        Name ${arrow('name')}
                                    </span>
                                    <button type="button" class="th-filter-btn ${isFiltered ? 'active' : ''}" id="btn-th-filter" title="Nach Name oder Typ filtern">
                                        ▾ ${esc(activeFilterSummary())}
                                    </button>
                                    ${isFiltered ? `<button type="button" class="th-filter-btn active" id="btn-th-filter-reset" title="Filter zurücksetzen">✕</button>` : ''}
                                    <div id="th-filter-menu" class="th-filter-menu ${state.filterMenuOpen ? '' : 'hidden'}">${filterMenuHtml}</div>
                                </div>
                            </th>
                            <th class="th-col-tag" style="width:48px;text-align:center">
                                <span class="th-sort-btn ${state.sortBy === 'tag' ? 'active' : ''}" data-sort-col="tag" title="Nach Farb-Tag sortieren">
                                    Tag ${arrow('tag')}
                                </span>
                            </th>
                            <th style="width:110px">
                                <span class="th-sort-btn ${state.sortBy === 'size' ? 'active' : ''}" data-sort-col="size" title="Nach Dateigröße sortieren">
                                    Größe ${arrow('size')}
                                </span>
                            </th>
                            <th class="hide-mobile" style="width:155px">
                                <span class="th-sort-btn ${state.sortBy === 'date' ? 'active' : ''}" data-sort-col="date" title="Nach Änderungsdatum sortieren">
                                    Geändert ${arrow('date')}
                                </span>
                            </th>
                        </tr>
                    </thead>
                    <tbody>
        `;

        if (allItems.length === 0) {
            html += `
                <tr>
                    <td colspan="5" class="empty-cell">
                        Keine Einträge für den Filter <strong>${esc(activeFilterSummary())}</strong> gefunden.
                        <button type="button" class="btn btn-ghost btn-sm" id="btn-empty-filter-reset" style="margin-left:0.5rem">Filter zurücksetzen</button>
                    </td>
                </tr>
            `;
        }

        for (const item of allItems) {
            const key = `${item.type}:${item.id}`;
            const isSel = state.selected.has(key);
            const isFolder = item.type === 'folder';
            const hasThumb = !isFolder && item.category === 'image' && !item.is_encrypted && !isTrash;

            let badges = '';
            if (item.is_encrypted || item.encrypted_count > 0) {
                badges += `<span class="badge badge-vault" title="AES-256-GCM verschlüsselt">🔒 Tresor</span>`;
            }
            if (item.share_count > 0) {
                badges += `<span class="badge badge-shared" title="Aktiv geteilt">🔗 Geteilt</span>`;
            }
            if (item.group_name) {
                badges += `<span class="badge badge-shared" title="Gruppenordner">👪 ${esc(item.group_name)}</span>`;
            }
            if (item.owner_name) {
                badges += `<span class="badge">👤 ${esc(item.owner_name)}</span>`;
            }

            html += `
                <tr data-key="${key}" data-type="${item.type}" data-id="${item.id}" draggable="${!isTrash && !item.is_group_folder}" class="${isSel ? 'selected' : ''}">
                    <td>
                        <input type="checkbox" class="row-chk" data-key="${key}" ${isSel ? 'checked' : ''}>
                    </td>
                    <td>
                        <div class="item-cell-wrap">
                            ${!isTrash && !item.is_group_root ? `
                                <button type="button" class="btn-fav ${item.is_favorite ? 'is-fav' : ''}" data-fav-type="${item.type}" data-fav-id="${item.id}" title="${item.is_favorite ? 'Aus Favoriten entfernen' : 'Zu Favoriten hinzufügen'}">
                                    ${item.is_favorite ? '★' : '☆'}
                                </button>
                            ` : ''}
                            <div class="item-cell" data-open="${key}">
                                ${hasThumb
                                    ? `<img class="item-thumb" loading="lazy" src="api.php?action=thumb&id=${item.id}" alt="">`
                                    : `<div class="item-icon">${isFolder ? '📁' : fileIcon(item)}</div>`
                                }
                                <div class="item-name-wrap">
                                    <span class="item-name">${esc(item.name)}</span>
                                    ${item.is_locked ? '<span class="item-locked-badge" title="Schreibgeschützt / Gesperrt">🔒</span>' : ''}
                                    ${item.alias_target_id ? '<span class="item-alias-badge" title="Verknüpfung / Alias">↗️</span>' : ''}
                                    ${item.version_count > 0 ? `<span class="item-version-badge" data-action="versions" title="Revisionsverlauf (${item.version_count} Vorversionen)">v${item.version_count + 1}</span>` : ''}
                                    ${item.notes ? `<span class="item-note-icon" data-action="note" title="Notiz: ${esc(item.notes)}">📝</span>` : ''}
                                    ${badges}
                                </div>
                            </div>
                        </div>
                    </td>
                    <td class="cell-tag" style="text-align:center">
                        ${item.color_tag ? `<span class="color-tag-dot color-${esc(item.color_tag)}" title="Tag: ${esc(colorTagNames[item.color_tag] || item.color_tag)}"></span>` : ''}
                    </td>
                    <td class="muted" style="white-space:nowrap">${isFolder ? '—' : formatBytes(item.size_bytes)}</td>
                    <td class="muted small hide-mobile">${esc((item.updated_at || '').replace('T', ' ').slice(0, 16))}</td>
                </tr>
            `;
        }

        html += `</tbody></table></div>`;
        container.innerHTML = html;

        // Bind sort & filter header controls
        $$('[data-sort-col]', container).forEach((el) => {
            el.addEventListener('click', () => {
                const col = el.dataset.sortCol;
                if (state.sortBy === col) {
                    state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
                } else {
                    state.sortBy = col;
                    state.sortDir = col === 'name' ? 'asc' : 'desc';
                }
                renderItems();
            });
        });

        $('#btn-th-filter', container)?.addEventListener('click', (e) => {
            e.stopPropagation();
            state.filterMenuOpen = !state.filterMenuOpen;
            const menu = $('#th-filter-menu', container);
            menu?.classList.toggle('hidden', !state.filterMenuOpen);
            if (state.filterMenuOpen) {
                $('#th-filter-text-inp', container)?.focus();
            }
        });

        $('#th-filter-menu', container)?.addEventListener('click', (e) => {
            e.stopPropagation();
        });

        $('#th-filter-text-inp', container)?.addEventListener('input', (e) => {
            const pos = e.target.selectionStart ?? e.target.value.length;
            state.filterText = e.target.value;
            state.filterMenuOpen = true;
            renderItems();
            const inp = $('#th-filter-text-inp');
            if (inp) {
                inp.focus();
                try { inp.setSelectionRange(pos, pos); } catch (_) {}
            }
        });

        $('#th-filter-text-inp', container)?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === 'Escape') {
                e.preventDefault();
                state.filterMenuOpen = false;
                $('#th-filter-menu', container)?.classList.add('hidden');
            }
        });

        $$('[data-filter-opt]', container).forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                state.filterType = btn.dataset.filterOpt;
                state.filterMenuOpen = false;
                renderItems();
            });
        });

        $('#btn-th-filter-reset', container)?.addEventListener('click', (e) => {
            e.stopPropagation();
            state.filterType = 'all';
            state.filterText = '';
            state.filterMenuOpen = false;
            renderItems();
        });

        $('#btn-empty-filter-reset', container)?.addEventListener('click', () => {
            state.filterType = 'all';
            state.filterText = '';
            state.filterMenuOpen = false;
            renderItems();
        });

        bindItemEvents(container, allItems);
    }

    function renderGridView(container, allItems) {
        const isTrash = state.view === 'trash';
        let html = `<div class="file-grid">`;

        for (const item of allItems) {
            const key = `${item.type}:${item.id}`;
            const isSel = state.selected.has(key);
            const isFolder = item.type === 'folder';
            const hasThumb = !isFolder && item.category === 'image' && !item.is_encrypted && !isTrash;

            html += `
                <div class="grid-card ${isSel ? 'selected' : ''}" data-key="${key}" data-type="${item.type}" data-id="${item.id}" draggable="${!isTrash && !item.is_group_folder}">
                    <div class="grid-card-top">
                        <input type="checkbox" class="row-chk" data-key="${key}" ${isSel ? 'checked' : ''}>
                        <div style="display:flex;align-items:center;gap:0.35rem">
                            ${!isTrash && !item.is_group_root ? `
                                <button type="button" class="btn-fav ${item.is_favorite ? 'is-fav' : ''}" data-fav-type="${item.type}" data-fav-id="${item.id}" title="${item.is_favorite ? 'Aus Favoriten entfernen' : 'Zu Favoriten hinzufügen'}">
                                    ${item.is_favorite ? '★' : '☆'}
                                </button>
                            ` : ''}
                            <span>${item.is_encrypted || item.encrypted_count > 0 ? '🔒' : (item.group_name ? '👪' : (item.share_count > 0 ? '🔗' : ''))}</span>
                        </div>
                    </div>
                    <div class="grid-preview" data-open="${key}">
                        ${hasThumb
                            ? `<img loading="lazy" src="api.php?action=thumb&id=${item.id}" alt="">`
                            : `<span>${isFolder ? '📁' : fileIcon(item)}</span>`
                        }
                    </div>
                    <div class="grid-title" data-open="${key}" title="${esc(item.name)}">
                        ${item.color_tag ? `<span class="color-tag-dot color-${esc(item.color_tag)}" title="Tag: ${esc(item.color_tag)}"></span>` : ''}
                        <span>${esc(item.name)}</span>
                        ${item.is_locked ? '<span class="item-locked-badge" title="Schreibgeschützt / Gesperrt">🔒</span>' : ''}
                        ${item.alias_target_id ? '<span class="item-alias-badge" title="Verknüpfung / Alias">↗️</span>' : ''}
                        ${item.notes ? `<span class="item-note-icon" data-action="note" title="Notiz: ${esc(item.notes)}">📝</span>` : ''}
                    </div>
                    <div class="grid-meta">
                        <span>${isFolder ? 'Ordner' : formatBytes(item.size_bytes)}</span>
                        ${item.version_count > 0 ? `<span class="item-version-badge" data-action="versions" title="Revisionsverlauf (${item.version_count} Vorversionen)">v${item.version_count + 1}</span>` : ''}
                    </div>
                </div>
            `;
        }

        html += `</div>`;
        container.innerHTML = html;
        bindItemEvents(container, allItems);
    }

    // Context Menu (Right-Click on Desktop / Long-Touch on Mobile)
    let contextMenuOpenedAt = 0;

    function closeContextMenu() {
        $('#context-menu')?.classList.add('hidden');
        $('#context-menu-backdrop')?.classList.add('hidden');
    }

    $('#context-menu-backdrop')?.addEventListener('click', (e) => {
        if (Date.now() - contextMenuOpenedAt < 650) {
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        closeContextMenu();
    });
    $('#context-menu-backdrop')?.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (Date.now() - contextMenuOpenedAt < 650) {
            return;
        }
        closeContextMenu();
    });
    window.addEventListener('scroll', () => {
        if (Date.now() - contextMenuOpenedAt < 650) return;
        closeContextMenu();
    }, true);

    // Clipboard (Copy / Cut / Paste) Management
    function setClipboard(mode, items) {
        if (!items || items.length === 0) return;
        state.clipboard = {
            mode: mode === 'cut' ? 'cut' : 'copy',
            items: items.map((x) => ({ type: x.type, id: x.id, name: x.name })),
        };
        updateClipboardToolbar();
        const label = state.clipboard.mode === 'cut' ? 'ausgeschnitten' : 'kopiert';
        toast(`${items.length} Element(e) ${label} – im Zielordner „Einfügen“ wählen.`);
    }

    function clearClipboard() {
        state.clipboard = null;
        updateClipboardToolbar();
    }

    function updateClipboardToolbar() {
        const bar = $('#clipboard-toolbar');
        const btn = $('#btn-clipboard-paste');
        if (!bar || !btn) return;
        if (!state.clipboard || !state.clipboard.items?.length || state.view === 'trash') {
            bar.classList.add('hidden');
            return;
        }
        const count = state.clipboard.items.length;
        const modeText = state.clipboard.mode === 'cut' ? 'Ausschneiden' : 'Kopieren';
        btn.textContent = `📥 Hier einfügen (${count} · ${modeText})`;
        bar.classList.remove('hidden');
    }

    async function pasteClipboard(targetFolderId) {
        if (!state.clipboard || !state.clipboard.items?.length) return;
        const isCut = state.clipboard.mode === 'cut';
        const action = isCut ? 'move' : 'copy';
        const items = state.clipboard.items;
        try {
            const res = await apiPost(action, { items, target_folder_id: targetFolderId });
            const count = isCut ? res.moved : res.copied;
            if (isCut) {
                clearClipboard();
            }
            toast(`${count} Element(e) ${isCut ? 'verschoben' : 'eingefügt'}.`);
            loadCurrentView();
        } catch (err) {
            toast(err.message, 'error');
        }
    }

    $('#btn-clipboard-paste')?.addEventListener('click', () => {
        pasteClipboard(state.currentFolderId);
    });
    $('#btn-clipboard-clear')?.addEventListener('click', () => {
        clearClipboard();
        toast('Zwischenablage geleert.');
    });

    function openContextMenu(item, clientX, clientY, splitSide = 'left') {
        const menu = $('#context-menu');
        const backdrop = $('#context-menu-backdrop');
        if (!menu || !backdrop) return;

        contextMenuOpenedAt = Date.now();

        const isTrash = state.view === 'trash';
        const isFolder = item.type === 'folder';
        const icon = isFolder ? '📁' : fileIcon(item);
        const activePaneFolderId = (state.layout === 'split' && splitSide === 'right')
            ? state.rightFolderId
            : state.currentFolderId;

        const key = `${item.type}:${item.id}`;
        const targetItems = state.selected.has(key)
            ? Array.from(state.selected.values())
            : [item];
        const countSuffix = targetItems.length > 1 ? ` (${targetItems.length})` : '';

        let itemsHtml = `<div class="context-menu-header">${icon} ${esc(item.name)}</div>`;

        if (isTrash) {
            itemsHtml += `
                <button type="button" class="dropdown-item" data-ctx-act="restore">♻️ Wiederherstellen</button>
                <button type="button" class="dropdown-item dropdown-item-danger" data-ctx-act="purge">❌ Endgültig löschen</button>
            `;
        } else if (item.is_group_root) {
            itemsHtml += `
                <button type="button" class="dropdown-item" data-ctx-act="open">📂 Gruppenordner öffnen</button>
            `;
        } else {
            itemsHtml += `
                <button type="button" class="dropdown-item" data-ctx-act="open">
                    ${isFolder ? '📂 Ordner öffnen' : '👁️ Öffnen / Vorschau'}
                </button>
                <button type="button" class="dropdown-item" data-ctx-act="toggle_favorite">
                    ${item.is_favorite ? '★ Aus Favoriten entfernen' : '⭐ Zu Favoriten hinzufügen'}
                </button>
            `;

            // Paste options when clipboard has items
            if (state.clipboard && state.clipboard.items?.length > 0 && ['owner', 'write'].includes(state.permission)) {
                const clipCount = state.clipboard.items.length;
                if (isFolder) {
                    itemsHtml += `
                        <button type="button" class="dropdown-item" data-ctx-act="paste_into">
                            📥 In „${esc(item.name)}“ einfügen (${clipCount})
                        </button>
                    `;
                }
                itemsHtml += `
                    <button type="button" class="dropdown-item" data-ctx-act="paste_here">
                        📥 Im aktuellen Ordner einfügen (${clipCount})
                    </button>
                `;
            }

            itemsHtml += `
                <div class="dropdown-divider"></div>
                <button type="button" class="dropdown-item" data-ctx-act="copy">
                    📋 Kopieren${countSuffix}
                </button>
            `;
            if (['owner', 'write'].includes(state.permission) && !item.is_group_folder) {
                itemsHtml += `
                    <button type="button" class="dropdown-item" data-ctx-act="cut">
                        ✂️ Ausschneiden${countSuffix}
                    </button>
                `;
            }
            itemsHtml += `<div class="dropdown-divider"></div>`;

            if (['owner', 'write'].includes(state.permission) && !item.is_group_folder) {
                itemsHtml += `
                    <div class="color-picker-bar">
                        <span class="muted small" style="margin-right:auto">Tag:</span>
                        <button type="button" class="color-dot-btn btn-clear-color" data-color="" title="Keine Markierung">✕</button>
                        <button type="button" class="color-dot-btn" data-color="red" style="background:#ef4444" title="Rot"></button>
                        <button type="button" class="color-dot-btn" data-color="orange" style="background:#f97316" title="Orange"></button>
                        <button type="button" class="color-dot-btn" data-color="yellow" style="background:#eab308" title="Gelb"></button>
                        <button type="button" class="color-dot-btn" data-color="green" style="background:#22c55e" title="Grün"></button>
                        <button type="button" class="color-dot-btn" data-color="blue" style="background:#3b82f6" title="Blau"></button>
                        <button type="button" class="color-dot-btn" data-color="purple" style="background:#a855f7" title="Lila"></button>
                    </div>
                    <button type="button" class="dropdown-item" data-ctx-act="notes">
                        📝 ${item.notes ? 'Notiz bearbeiten' : 'Notiz hinzufügen'}
                    </button>
                `;
            }
            if (!isFolder) {
                itemsHtml += `
                    <button type="button" class="dropdown-item" data-ctx-act="versions">
                        🕒 Revisionsverlauf ${item.version_count > 0 ? `(${item.version_count + 1})` : ''}
                    </button>
                `;
            }

            if (state.permission === 'owner' || item.is_group_folder || state.isGroupTree) {
                itemsHtml += `
                    <button type="button" class="dropdown-item" data-ctx-act="share">
                        ${(item.is_group_folder || state.isGroupTree) ? '🔗 Teilen (Öffentlicher Link)' : '🔗 Teilen (Link / Benutzer)'}
                    </button>
                `;
            }
            itemsHtml += `
                <button type="button" class="dropdown-item" data-ctx-act="download">
                    ${targetItems.length > 1 ? `📦 Als ZIP herunterladen (${targetItems.length})` : (isFolder ? '📦 Als ZIP herunterladen' : '⬇️ Herunterladen')}
                </button>
            `;
            if (!isFolder && item.category === 'zip' && !item.is_encrypted) {
                itemsHtml += `
                    <button type="button" class="dropdown-item" data-ctx-act="unzip">
                        📂 ZIP hier entpacken
                    </button>
                `;
            }
            if (!isFolder && item.category === 'pdf' && !item.is_encrypted && ['owner', 'write'].includes(state.permission)) {
                itemsHtml += `
                    <button type="button" class="dropdown-item" data-ctx-act="rotate_pdf">
                        🔄 Seiten um 90° drehen
                    </button>
                `;
            }
            if (!isFolder && item.category === 'audio') {
                itemsHtml += `
                    <button type="button" class="dropdown-item" data-ctx-act="play_audio">
                        🎵 Im Hintergrund abspielen
                    </button>
                `;
            }
            if (!isFolder && (item.category === 'image' || item.category === 'pdf') && !item.is_encrypted) {
                itemsHtml += `
                    <button type="button" class="dropdown-item" data-ctx-act="ocr">
                        🔍 Text erkennen (OCR)
                    </button>
                `;
            }
            if (!isFolder && item.category === 'image' && !item.is_encrypted && ['owner', 'write'].includes(state.permission)) {
                itemsHtml += `
                    <button type="button" class="dropdown-item" data-ctx-act="optimize_image">
                        🗜️ Bild optimieren (WebP)
                    </button>
                `;
            }
            if (isFolder && !isTrash) {
                itemsHtml += `
                    <button type="button" class="dropdown-item" data-ctx-act="storage_radar">
                        📊 Speicherplatz-Radar
                    </button>
                `;
            }
            if (!isFolder && item.category === 'image') {
                itemsHtml += `
                    <button type="button" class="dropdown-item" data-ctx-act="exif_data">
                        🧭 EXIF & GPS-Daten
                    </button>
                `;
            }
            if (!isFolder && item.category === 'pdf' && !item.is_encrypted && ['owner', 'write'].includes(state.permission)) {
                itemsHtml += `
                    <button type="button" class="dropdown-item" data-ctx-act="sign_pdf">
                        ✍️ Unterschreiben / Signieren
                    </button>
                `;
            }
            if (!isTrash && !item.is_group_folder && ['owner', 'write'].includes(state.permission)) {
                itemsHtml += `
                    <button type="button" class="dropdown-item" data-ctx-act="toggle_lock">
                        ${item.is_locked ? '🔓 Schreibschutz aufheben' : '🔒 Schreibschutz aktivieren'}
                    </button>
                `;
            }
            if (!isTrash && !item.is_group_folder && ['owner', 'write'].includes(state.permission)) {
                itemsHtml += `
                    <button type="button" class="dropdown-item" data-ctx-act="create_alias">
                        🔗 Verknüpfung erstellen
                    </button>
                `;
            }
            if (['owner', 'write'].includes(state.permission)) {
                if (isFolder) {
                    itemsHtml += `
                        <button type="button" class="dropdown-item" data-ctx-act="vault">
                            ${item.encrypted_count > 0 ? '🔓 Ordner im Tresor ver-/entschlüsseln' : '🔒 Ordner im Tresor verschlüsseln (AES-256)'}
                        </button>
                    `;
                } else {
                    itemsHtml += `
                        <button type="button" class="dropdown-item" data-ctx-act="vault">
                            ${item.is_encrypted ? '🔓 Tresor entschlüsseln' : '🔒 Im Tresor verschlüsseln (AES-256)'}
                        </button>
                    `;
                }
            }
            if (['owner', 'write'].includes(state.permission) && !item.is_group_folder) {
                itemsHtml += `<div class="dropdown-divider"></div>`;
                if (targetItems.length > 1) {
                    itemsHtml += `<button type="button" class="dropdown-item" data-ctx-act="batch_rename">🏷️ Massen-Umbenennung (${targetItems.length})</button>`;
                } else {
                    itemsHtml += `<button type="button" class="dropdown-item" data-ctx-act="rename">✏️ Umbenennen</button>`;
                }
                itemsHtml += `<button type="button" class="dropdown-item dropdown-item-danger" data-ctx-act="trash">🗑️ In den Papierkorb</button>`;
            }
        }

        menu.innerHTML = itemsHtml;
        backdrop.classList.remove('hidden');
        menu.classList.remove('hidden');

        // Position near cursor on desktop (CSS media query overrides to bottom sheet on mobile <= 768px)
        const rect = menu.getBoundingClientRect();
        const x = Math.min(clientX, Math.max(12, window.innerWidth - rect.width - 12));
        const y = Math.min(clientY, Math.max(12, window.innerHeight - rect.height - 12));
        menu.style.left = `${x}px`;
        menu.style.top = `${y}px`;

        $$('.color-dot-btn', menu).forEach((btn) => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                closeContextMenu();
                const col = btn.dataset.color || null;
                try {
                    await apiPost('set_color_tag', {
                        items: targetItems.map((x) => ({ type: x.type, id: x.id })),
                        color: col,
                    });
                    toast(col ? 'Farb-Tag zugewiesen.' : 'Farb-Tag entfernt.');
                    loadCurrentView();
                } catch (err) {
                    toast(err.message, 'error');
                }
            });
        });

        $$('[data-ctx-act]', menu).forEach((btn) => {
            btn.addEventListener('click', () => {
                const act = btn.dataset.ctxAct;
                closeContextMenu();
                if (act === 'open') {
                    if (isFolder) {
                        if (state.layout === 'split' && splitSide === 'right') {
                            state.rightFolderId = item.id;
                        } else {
                            state.currentFolderId = item.id;
                        }
                        state.search = '';
                        $('#search-input').value = '';
                        loadCurrentView();
                    } else {
                        openFileModal(item);
                    }
                } else if (act === 'copy') {
                    setClipboard('copy', targetItems);
                } else if (act === 'cut') {
                    setClipboard('cut', targetItems);
                } else if (act === 'paste_into') {
                    pasteClipboard(item.id);
                } else if (act === 'paste_here') {
                    pasteClipboard(activePaneFolderId);
                } else {
                    handleItemAction(act, item);
                }
            });
        });
    }

    // Background Context Menu (Right-click or Long-touch on empty folder space)
    function openBackgroundContextMenu(clientX, clientY, targetFolderId) {
        if (state.view !== 'files' && state.view !== 'shared') return;
        if (!['owner', 'write'].includes(state.permission)) return;

        const menu = $('#context-menu');
        const backdrop = $('#context-menu-backdrop');
        if (!menu || !backdrop) return;

        contextMenuOpenedAt = Date.now();
        const hasClip = state.clipboard && state.clipboard.items?.length > 0;
        const clipCount = hasClip ? state.clipboard.items.length : 0;

        let html = `<div class="context-menu-header">📂 Aktueller Ordner</div>`;
        if (hasClip) {
            html += `
                <button type="button" class="dropdown-item" data-bg-act="paste">
                    📥 Hier einfügen (${clipCount} Element${clipCount > 1 ? 'e' : ''})
                </button>
                <div class="dropdown-divider"></div>
            `;
        }
        html += `
            <button type="button" class="dropdown-item" data-bg-act="new_folder">📁 Neuer Ordner</button>
            <button type="button" class="dropdown-item" data-bg-act="new_text">📝 Neue Textdatei</button>
            <button type="button" class="dropdown-item" data-bg-act="voice_memo">🎙️ Sprachnotiz aufnehmen</button>
            <button type="button" class="dropdown-item" data-bg-act="upload">⬆️ Dateien hochladen</button>
        `;

        menu.innerHTML = html;
        backdrop.classList.remove('hidden');
        menu.classList.remove('hidden');

        const rect = menu.getBoundingClientRect();
        menu.style.left = `${Math.min(clientX, Math.max(12, window.innerWidth - rect.width - 12))}px`;
        menu.style.top = `${Math.min(clientY, Math.max(12, window.innerHeight - rect.height - 12))}px`;

        $$('[data-bg-act]', menu).forEach((btn) => {
            btn.addEventListener('click', () => {
                const act = btn.dataset.bgAct;
                closeContextMenu();
                if (act === 'paste') {
                    pasteClipboard(targetFolderId);
                } else if (act === 'new_folder') {
                    $('#btn-new-folder')?.click();
                } else if (act === 'new_text') {
                    $('#btn-new-text')?.click();
                } else if (act === 'voice_memo') {
                    openVoiceMemoModal();
                } else if (act === 'upload') {
                    $('#file-input-multi')?.click();
                }
            });
        });
    }

    // Bind background right-click & long-touch on #file-viewport
    (() => {
        const vp = $('#file-viewport');
        if (!vp) return;
        vp.addEventListener('contextmenu', (e) => {
            if (e.target.closest('[data-key]')) return;
            e.preventDefault();
            const pane = e.target.closest('.split-pane');
            const folderId = pane
                ? (pane.dataset.paneFolder === '' ? null : Number(pane.dataset.paneFolder))
                : state.currentFolderId;
            openBackgroundContextMenu(e.clientX, e.clientY, folderId);
        });

        let bgTimer = null;
        let bgX = 0;
        let bgY = 0;
        vp.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 1 || e.target.closest('[data-key]') || e.target.closest('button, a, input')) return;
            bgX = e.touches[0].clientX;
            bgY = e.touches[0].clientY;
            const pane = e.target.closest('.split-pane');
            const folderId = pane
                ? (pane.dataset.paneFolder === '' ? null : Number(pane.dataset.paneFolder))
                : state.currentFolderId;
            bgTimer = setTimeout(() => {
                if (navigator.vibrate) {
                    try { navigator.vibrate(15); } catch (_) {}
                }
                openBackgroundContextMenu(bgX, bgY, folderId);
            }, 450);
        }, { passive: true });
        vp.addEventListener('touchmove', (e) => {
            if (!bgTimer || e.touches.length !== 1) return;
            if (Math.abs(e.touches[0].clientX - bgX) > 12 || Math.abs(e.touches[0].clientY - bgY) > 12) {
                clearTimeout(bgTimer);
                bgTimer = null;
            }
        }, { passive: true });
        vp.addEventListener('touchend', () => { if (bgTimer) { clearTimeout(bgTimer); bgTimer = null; } }, { passive: true });
        vp.addEventListener('touchcancel', () => { if (bgTimer) { clearTimeout(bgTimer); bgTimer = null; } }, { passive: true });
    })();

    function getOrCreateTouchGhost() {
        let g = $('#touch-drag-ghost');
        if (!g) {
            g = document.createElement('div');
            g.id = 'touch-drag-ghost';
            g.className = 'touch-drag-ghost hidden';
            document.body.appendChild(g);
        }
        return g;
    }

    function bindContextMenuEvents(el, item, splitSide = 'left') {
        // 1. Desktop Right-Click
        el.addEventListener('contextmenu', (e) => {
            if (el.dataset.touchActive === '1') {
                e.preventDefault();
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            openContextMenu(item, e.clientX, e.clientY, splitSide);
        });

        // 2. Mobile Long-Touch (~430ms):
        //    - Hold & lift finger without moving -> Opens Context Menu
        //    - Hold & drag finger -> Moves item(s) onto hovered folder or breadcrumb!
        let touchTimer = null;
        let startX = 0;
        let startY = 0;
        let lastX = 0;
        let lastY = 0;
        let armed = false;
        let dragging = false;
        let hoveredTargetEl = null;
        let hoveredFolderId = undefined; // undefined = no target, null = root folder, number = subfolder ID
        let hoveredFolderName = '';

        const clearHoveredTarget = () => {
            if (hoveredTargetEl) {
                hoveredTargetEl.classList.remove('drag-over');
                hoveredTargetEl = null;
            }
            hoveredFolderId = undefined;
            hoveredFolderName = '';
        };

        el.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 1 || e.target.closest('input, button, a')) return;
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
            lastX = startX;
            lastY = startY;
            armed = false;
            dragging = false;
            el.dataset.touchActive = '1';

            touchTimer = setTimeout(() => {
                touchTimer = null;
                armed = true;
                el.dataset.longPressed = '1';
                el.classList.add('touch-armed');
                if (navigator.vibrate) {
                    try { navigator.vibrate(18); } catch (_) {}
                }
            }, 430);
        }, { passive: true });

        el.addEventListener('touchmove', (e) => {
            if (e.touches.length !== 1) return;
            const tx = e.touches[0].clientX;
            const ty = e.touches[0].clientY;
            lastX = tx;
            lastY = ty;
            const dx = Math.abs(tx - startX);
            const dy = Math.abs(ty - startY);

            if (!armed) {
                if (dx > 12 || dy > 12) {
                    if (touchTimer) {
                        clearTimeout(touchTimer);
                        touchTimer = null;
                    }
                }
                return;
            }

            // Armed! If the user moves their finger after the 430ms vibration, switch to Touch-Drag mode
            if (!dragging && (dx > 10 || dy > 10)) {
                if (state.view === 'trash' || item.is_group_folder) return;
                dragging = true;
                closeContextMenu();
            }

            if (dragging) {
                if (e.cancelable) e.preventDefault();

                const key = `${item.type}:${item.id}`;
                const dragCount = state.selected.has(key) ? state.selected.size : 1;
                const baseLabel = dragCount > 1
                    ? `📦 ${dragCount} Elemente`
                    : `${item.type === 'folder' ? '📁' : '📄'} ${item.name}`;

                const ghost = getOrCreateTouchGhost();
                ghost.classList.remove('hidden');
                ghost.style.left = `${tx}px`;
                ghost.style.top = `${ty}px`;

                // Auto-scroll #file-viewport near top/bottom edges
                const vp = $('#file-viewport');
                if (vp) {
                    const vpRect = vp.getBoundingClientRect();
                    if (ty < vpRect.top + 55) {
                        vp.scrollTop -= 10;
                    } else if (ty > vpRect.bottom - 55) {
                        vp.scrollTop += 10;
                    }
                }

                // Detect drop target under finger
                const underEl = document.elementFromPoint(tx, ty);
                const folderRow = underEl?.closest('[data-type="folder"]');
                const crumbEl = underEl?.closest('.crumb[data-crumb-id], [data-split-crumb]');

                clearHoveredTarget();

                if (folderRow && Number(folderRow.dataset.id) !== item.id) {
                    hoveredTargetEl = folderRow;
                    hoveredFolderId = Number(folderRow.dataset.id);
                    hoveredFolderName = folderRow.querySelector('.item-name, .grid-title')?.textContent || 'Ordner';
                    hoveredTargetEl.classList.add('drag-over');
                    ghost.textContent = `📥 In „${hoveredFolderName}“`;
                } else if (crumbEl) {
                    hoveredTargetEl = crumbEl;
                    const rawId = crumbEl.dataset.crumbId ?? crumbEl.dataset.folderId ?? '';
                    hoveredFolderId = rawId === '' ? null : Number(rawId);
                    hoveredFolderName = crumbEl.textContent || 'Ordner';
                    hoveredTargetEl.classList.add('drag-over');
                    ghost.textContent = `📥 Nach „${hoveredFolderName}“`;
                } else {
                    ghost.textContent = baseLabel;
                }
            }
        }, { passive: false });

        const finishTouch = async (cancelled = false) => {
            if (touchTimer) {
                clearTimeout(touchTimer);
                touchTimer = null;
            }
            el.classList.remove('touch-armed');
            setTimeout(() => { el.dataset.touchActive = '0'; }, 300);

            const ghost = $('#touch-drag-ghost');
            if (ghost) ghost.classList.add('hidden');

            if (cancelled) {
                clearHoveredTarget();
                armed = false;
                dragging = false;
                return;
            }

            if (armed && !dragging) {
                // User held finger for 430ms and lifted without dragging -> Open Context Menu!
                armed = false;
                openContextMenu(item, lastX, lastY, splitSide);
                return;
            }

            if (dragging) {
                const targetId = hoveredFolderId;
                const targetName = hoveredFolderName;
                clearHoveredTarget();
                armed = false;
                dragging = false;

                if (targetId !== undefined) {
                    const key = `${item.type}:${item.id}`;
                    const dragItems = state.selected.has(key)
                        ? Array.from(state.selected.values()).map((x) => ({ type: x.type, id: x.id, name: x.name }))
                        : [{ type: item.type, id: item.id, name: item.name }];

                    try {
                        const res = await apiPost('move', { items: dragItems, target_folder_id: targetId });
                        if (res.moved > 0) {
                            toast(`In „${targetName}“ verschoben.`);
                            loadCurrentView();
                        }
                    } catch (err) {
                        toast(err.message, 'error');
                    }
                }
            }
        };

        el.addEventListener('touchend', () => finishTouch(false), { passive: true });
        el.addEventListener('touchcancel', () => finishTouch(true), { passive: true });
    }

    function bindItemEvents(container, allItems) {
        const itemMap = new Map(allItems.map((it) => [`${it.type}:${it.id}`, it]));

        // Select All checkbox
        const selectAll = $('#select-all-chk', container);
        if (selectAll) {
            selectAll.checked = allItems.length > 0 && state.selected.size === allItems.length;
            selectAll.addEventListener('change', () => {
                if (selectAll.checked) {
                    allItems.forEach((it) => state.selected.set(`${it.type}:${it.id}`, it));
                } else {
                    state.selected.clear();
                }
                renderItems();
                updateBulkToolbar();
            });
        }

        // Row Checkboxes
        $$('.row-chk', container).forEach((chk) => {
            chk.addEventListener('click', (e) => e.stopPropagation());
            chk.addEventListener('change', () => {
                const key = chk.dataset.key;
                const it = itemMap.get(key);
                if (!it) return;
                if (chk.checked) {
                    state.selected.set(key, it);
                } else {
                    state.selected.delete(key);
                }
                const row = chk.closest('[data-key]');
                if (row) row.classList.toggle('selected', chk.checked);
                updateBulkToolbar();
            });
        });

        // Favorite Star button
        $$('.btn-fav', container).forEach((btn) => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                e.preventDefault();
                const type = btn.dataset.favType;
                const id = parseInt(btn.dataset.favId, 10);
                await toggleFavoriteItem(type, id, btn);
            });
        });

        // Click to Open Folder or File Preview
        $$('[data-open]', container).forEach((el) => {
            el.addEventListener('click', (e) => {
                const row = el.closest('[data-key]');
                if (row?.dataset.longPressed === '1') {
                    row.dataset.longPressed = '0';
                    e.preventDefault();
                    return;
                }
                const key = el.dataset.open;
                const item = itemMap.get(key);
                if (!item) return;

                const noteBtn = e.target.closest('[data-action="note"]');
                if (noteBtn) {
                    e.stopPropagation();
                    openNotesModal(item);
                    return;
                }
                const verBtn = e.target.closest('[data-action="versions"]');
                if (verBtn) {
                    e.stopPropagation();
                    openVersionsModal(item);
                    return;
                }

                if (state.view === 'trash') {
                    openContextMenu(item, e.clientX || 120, e.clientY || 120);
                    return;
                }
                if (item.type === 'folder') {
                    state.currentFolderId = item.id;
                    state.search = '';
                    $('#search-input').value = '';
                    loadCurrentView();
                } else {
                    openFileModal(item);
                }
            });
        });

        // Context Menu & Internal Drag & Drop (move items into folders)
        $$('[data-key]', container).forEach((row) => {
            const key = row.dataset.key;
            const item = itemMap.get(key);
            if (!item) return;

            bindContextMenuEvents(row, item, 'left');

            row.addEventListener('dragstart', (e) => {
                let dragList = [{ type: item.type, id: item.id, name: item.name }];
                if (state.selected.has(key)) {
                    dragList = Array.from(state.selected.values()).map((x) => ({ type: x.type, id: x.id, name: x.name }));
                }
                e.dataTransfer.setData('application/x-cloud-item', JSON.stringify(dragList));
                e.dataTransfer.effectAllowed = 'move';
            });

            if (item.type === 'folder' && state.view !== 'trash') {
                row.addEventListener('dragover', (e) => {
                    e.preventDefault();
                    row.classList.add('drag-over');
                    const lbl = $('#drop-target-label');
                    if (lbl) lbl.textContent = `In Ordner „${item.name}“ ablegen`;
                });
                row.addEventListener('dragleave', () => {
                    row.classList.remove('drag-over');
                    const lbl = $('#drop-target-label');
                    if (lbl) lbl.textContent = 'Dateien hier ablegen (oder direkt auf einen Ordner ziehen)';
                });
                row.addEventListener('drop', async (e) => {
                    row.classList.remove('drag-over');
                    const internalData = e.dataTransfer.getData('application/x-cloud-item');
                    if (internalData) {
                        e.preventDefault();
                        e.stopPropagation();
                        try {
                            const items = JSON.parse(internalData);
                            const res = await apiPost('move', { items, target_folder_id: item.id });
                            if (res.moved > 0) {
                                toast(`In "${item.name}" verschoben.`);
                                loadCurrentView();
                            }
                        } catch (err) {
                            toast(err.message, 'error');
                        }
                        return;
                    }

                    // External files dropped directly onto a subfolder row!
                    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                        e.preventDefault();
                        e.stopPropagation();
                        const entries = await extractDroppedFileEntries(e.dataTransfer);
                        await uploadFileEntries(entries, item.id);
                    }
                });
            }
        });
    }

    function updateBulkToolbar() {
        updateClipboardToolbar();
        const count = state.selected.size;
        const bar = $('#bulk-toolbar');
        if (count === 0) {
            bar.classList.add('hidden');
            return;
        }
        bar.classList.remove('hidden');
        $('#bulk-count').textContent = `${count} ausgewählt`;

        const isTrash = state.view === 'trash';
        const selectedList = Array.from(state.selected.values());
        const allPdfs = selectedList.length >= 2 && selectedList.every((it) => it.type === 'file' && (it.mime_type === 'application/pdf' || it.name.toLowerCase().endsWith('.pdf')));
        const canRename = !isTrash && count >= 2 && ['owner', 'write'].includes(state.permission);
        $('#btn-bulk-rename')?.classList.toggle('hidden', !canRename);
        $('#btn-bulk-merge-pdf')?.classList.toggle('hidden', isTrash || !allPdfs);
        $('#btn-bulk-copy')?.classList.toggle('hidden', isTrash);
        $('#btn-bulk-cut')?.classList.toggle('hidden', isTrash);
        $('#btn-bulk-download').classList.toggle('hidden', isTrash);
        $('#btn-bulk-trash').classList.toggle('hidden', isTrash);
        $('#btn-bulk-restore').classList.toggle('hidden', !isTrash);
        $('#btn-bulk-purge').classList.toggle('hidden', !isTrash);
    }

    $('#btn-bulk-rename')?.addEventListener('click', () => {
        const items = Array.from(state.selected.values());
        if (items.length >= 2) {
            openBatchRenameModal(items);
        }
    });

    $('#btn-storage-radar')?.addEventListener('click', () => openStorageAnalysisModal());
    $('#btn-quota-radar')?.addEventListener('click', () => openStorageAnalysisModal());

    $('#btn-bulk-merge-pdf')?.addEventListener('click', async () => {
        const items = Array.from(state.selected.values()).filter((it) => it.type === 'file');
        if (items.length < 2) return;
        const defaultName = items[0].name.replace(/\.pdf$/i, '') + '_zusammengefuehrt.pdf';
        const name = prompt('Name für die zusammengeführte PDF-Datei:', defaultName);
        if (!name) return;

        try {
            toast('Führe PDFs zusammen…');
            const res = await apiPost('pdf_merge', {
                file_ids: items.map((it) => it.id),
                name: name.trim(),
                target_folder_id: state.currentFolderId,
            });
            toast(`PDF „${res.file.name}“ erfolgreich erstellt!`);
            state.selected.clear();
            updateBulkToolbar();
            loadCurrentView();
        } catch (err) {
            toast(err.message, 'error');
        }
    });

    // Individual Row Actions
    async function handleItemAction(act, item) {
        switch (act) {
            case 'download':
                const targetKey = `${item.type}:${item.id}`;
                const targetItems = state.selected.has(targetKey) ? Array.from(state.selected.values()) : [item];
                if (targetItems.length > 1 || item.type === 'folder') {
                    triggerZipDownload(targetItems);
                } else if (item.is_encrypted) {
                    openVaultModal(item);
                } else {
                    window.location.href = `api.php?action=download&id=${item.id}`;
                }
                break;

            case 'rotate_pdf':
                try {
                    await apiPost('pdf_rotate', { file_id: item.id, angle: 90 });
                    toast('PDF-Seiten erfolgreich um 90° gedreht.');
                    loadCurrentView();
                } catch (err) {
                    toast(err.message, 'error');
                }
                break;

            case 'play_audio':
                playDockAudio(item);
                break;

            case 'ocr':
                openOcrModal(item);
                break;

            case 'optimize_image':
                openImageOptimizeModal(item);
                break;

            case 'batch_rename':
                const batchItems = state.selected.size > 1 ? Array.from(state.selected.values()) : [item];
                openBatchRenameModal(batchItems);
                break;

            case 'storage_radar':
                openStorageAnalysisModal();
                break;

            case 'toggle_lock':
                try {
                    const res = await apiPost('toggle_lock', { type: item.type, id: item.id });
                    toast(res.is_locked ? 'Schreibschutz aktiviert.' : 'Schreibschutz aufgehoben.');
                    loadCurrentView();
                } catch (err) {
                    toast(err.message, 'error');
                }
                break;

            case 'create_alias':
                try {
                    const aliasRes = await apiPost('create_alias', {
                        target_type: item.type,
                        target_id: item.id,
                        target_folder_id: state.currentFolderId,
                    });
                    toast(`Verknüpfung „${aliasRes.alias.name}“ erstellt.`);
                    loadCurrentView();
                } catch (err) {
                    toast(err.message, 'error');
                }
                break;

            case 'exif_data':
                openExifModal(item);
                break;

            case 'sign_pdf':
                openPdfSignModal(item);
                break;

            case 'rename':
                openRenameModal(item);
                break;

            case 'trash':
                try {
                    await apiPost('trash', { items: [{ type: item.type, id: item.id, name: item.name }] });
                    toast(`"${item.name}" in den Papierkorb verschoben.`);
                    loadCurrentView();
                } catch (err) {
                    toast(err.message, 'error');
                }
                break;

            case 'restore':
                try {
                    await apiPost('restore', { items: [{ type: item.type, id: item.id }] });
                    toast(`"${item.name}" wiederhergestellt.`);
                    loadCurrentView();
                } catch (err) {
                    toast(err.message, 'error');
                }
                break;

            case 'purge':
                if (!confirm(`"${item.name}" wirklich unwiderruflich löschen?`)) return;
                try {
                    await apiPost('delete_permanent', { items: [{ type: item.type, id: item.id }] });
                    toast(`"${item.name}" endgültig gelöscht.`);
                    loadCurrentView();
                } catch (err) {
                    toast(err.message, 'error');
                }
                break;

            case 'vault':
                openVaultModal(item);
                break;

            case 'toggle_favorite':
                await toggleFavoriteItem(item.type, item.id);
                break;

            case 'unzip':
                openZipModal(item);
                break;

            case 'share':
                openShareModal(item);
                break;

            case 'notes':
                openNotesModal(item);
                break;

            case 'versions':
                openVersionsModal(item);
                break;
        }
    }

    async function toggleFavoriteItem(type, id, btnElement = null) {
        try {
            const res = await apiPost('toggle_favorite', { type, id });
            const isFav = Boolean(res.is_favorite);
            const list = type === 'folder' ? state.folders : state.files;
            const item = list.find((x) => x.id === id);
            if (item) {
                item.is_favorite = isFav;
            }
            if (state.view === 'favorites' && !isFav) {
                loadCurrentView();
                toast('Aus Favoriten entfernt.');
                return;
            }
            if (btnElement) {
                btnElement.classList.toggle('is-fav', isFav);
                btnElement.textContent = isFav ? '★' : '☆';
                btnElement.title = isFav ? 'Aus Favoriten entfernen' : 'Zu Favoriten hinzufügen';
            } else {
                renderItems();
            }
            toast(isFav ? 'Zu Favoriten hinzugefügt.' : 'Aus Favoriten entfernt.');
        } catch (err) {
            toast(err.message, 'error');
        }
    }

    // Bulk Toolbar Actions
    $('#btn-bulk-copy')?.addEventListener('click', () => {
        setClipboard('copy', Array.from(state.selected.values()));
    });

    $('#btn-bulk-cut')?.addEventListener('click', () => {
        setClipboard('cut', Array.from(state.selected.values()));
    });

    // Keyboard shortcuts: Ctrl+C (Copy), Ctrl+X (Cut), Ctrl+V (Paste)
    document.addEventListener('keydown', (e) => {
        if (!state.user || !$('#modal-backdrop').classList.contains('hidden')) return;
        const tag = (e.target?.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target?.isContentEditable) return;

        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && state.selected.size > 0 && state.view !== 'trash') {
            e.preventDefault();
            setClipboard('copy', Array.from(state.selected.values()));
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x' && state.selected.size > 0 && state.view !== 'trash') {
            e.preventDefault();
            setClipboard('cut', Array.from(state.selected.values()));
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v' && state.clipboard?.items?.length > 0 && state.view === 'files') {
            e.preventDefault();
            pasteClipboard(state.currentFolderId);
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && state.undoStack.length > 0) {
            e.preventDefault();
            executeUndo();
        }
    });

    $('#btn-bulk-download')?.addEventListener('click', () => {
        const items = Array.from(state.selected.values());
        if (items.length === 1 && items[0].type === 'file' && !items[0].is_encrypted) {
            window.location.href = `api.php?action=download&id=${items[0].id}`;
        } else {
            triggerZipDownload(items);
        }
    });

    function triggerZipDownload(items) {
        const minimal = items.map((x) => ({ type: x.type, id: x.id, name: x.name }));
        const url = `api.php?action=download_zip&items=${encodeURIComponent(JSON.stringify(minimal))}`;
        window.location.href = url;
    }

    $('#btn-bulk-trash')?.addEventListener('click', async () => {
        const items = Array.from(state.selected.values()).map((x) => ({ type: x.type, id: x.id, name: x.name }));
        try {
            await apiPost('trash', { items });
            toast(`${items.length} Element(e) in den Papierkorb verschoben.`);
            loadCurrentView();
        } catch (err) {
            toast(err.message, 'error');
        }
    });

    $('#btn-bulk-restore')?.addEventListener('click', async () => {
        const items = Array.from(state.selected.values()).map((x) => ({ type: x.type, id: x.id }));
        try {
            await apiPost('restore', { items });
            toast(`${items.length} Element(e) wiederhergestellt.`);
            loadCurrentView();
        } catch (err) {
            toast(err.message, 'error');
        }
    });

    $('#btn-bulk-purge')?.addEventListener('click', async () => {
        const items = Array.from(state.selected.values()).map((x) => ({ type: x.type, id: x.id }));
        if (!confirm(`${items.length} Element(e) wirklich endgültig löschen?`)) return;
        try {
            await apiPost('delete_permanent', { items });
            toast(`${items.length} Element(e) endgültig gelöscht.`);
            loadCurrentView();
        } catch (err) {
            toast(err.message, 'error');
        }
    });

    $('#btn-empty-trash')?.addEventListener('click', async () => {
        if (!confirm('Gesamten Papierkorb unwiderruflich leeren?')) return;
        try {
            await apiPost('empty_trash');
            toast('Papierkorb geleert.');
            loadCurrentView();
        } catch (err) {
            toast(err.message, 'error');
        }
    });

    $('#btn-bulk-move')?.addEventListener('click', async () => {
        const items = Array.from(state.selected.values()).map((x) => ({ type: x.type, id: x.id }));
        try {
            const res = await apiGet({ action: 'folder_tree' });
            const folders = res.folders || [];
            let opts = `<option value="">📁 Meine Dateien (Hauptordner)</option>`;
            for (const f of folders) {
                opts += `<option value="${f.id}">📁 ${esc(f.name)}</option>`;
            }
            openModal('Auswahl verschieben', `
                <form id="move-modal-form">
                    <div class="form-group">
                        <label>Zielordner auswählen</label>
                        <select name="target_folder_id" class="input">${opts}</select>
                    </div>
                    <button type="submit" class="btn btn-primary btn-block">Hierhin verschieben</button>
                </form>
            `);
            $('#move-modal-form').addEventListener('submit', async (e) => {
                e.preventDefault();
                const targetId = e.target.target_folder_id.value;
                try {
                    await apiPost('move', { items, target_folder_id: targetId === '' ? null : Number(targetId) });
                    closeModal();
                    toast('Elemente verschoben.');
                    loadCurrentView();
                } catch (err) {
                    toast(err.message, 'error');
                }
            });
        } catch (err) {
            toast(err.message, 'error');
        }
    });

    // Create Folder Modal
    $('#btn-new-folder')?.addEventListener('click', () => {
        openModal('Neuer Ordner', `
            <form id="new-folder-form">
                <div class="form-group">
                    <label>Ordnername</label>
                    <input type="text" name="name" class="input" placeholder="z. B. Rechnungen 2026" required autofocus>
                </div>
                <button type="submit" class="btn btn-primary btn-block">Ordner erstellen</button>
            </form>
        `);
        $('#new-folder-form').querySelector('input').focus();
        $('#new-folder-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const name = e.target.name.value.trim();
            try {
                await apiPost('create_folder', { parent_id: state.currentFolderId, name });
                closeModal();
                toast(`Ordner "${name}" erstellt.`);
                loadCurrentView();
            } catch (err) {
                toast(err.message, 'error');
            }
        });
    });

    // Rename Modal
    function openRenameModal(item) {
        openModal('Umbenennen', `
            <form id="rename-form">
                <div class="form-group">
                    <label>Neuer Name</label>
                    <input type="text" name="name" class="input" value="${esc(item.name)}" required>
                </div>
                <button type="submit" class="btn btn-primary btn-block">Speichern</button>
            </form>
        `);
        const inp = $('#rename-form').querySelector('input');
        inp.focus();
        inp.select();
        $('#rename-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            try {
                await apiPost('rename', { type: item.type, id: item.id, name: inp.value.trim(), old_name: item.name });
                closeModal();
                toast('Umbenannt.');
                loadCurrentView();
            } catch (err) {
                toast(err.message, 'error');
            }
        });
    }

    // Notes Modal (Files and Folders)
    function openNotesModal(item) {
        openModal(`📝 Notiz für „${esc(item.name)}“`, `
            <div style="display:flex;flex-direction:column;gap:0.75rem">
                <p class="muted small" style="margin:0">
                    Fügen Sie eine Notiz oder Beschreibung hinzu. Diese wird mit einem 📝-Symbol direkt neben dem Namen angezeigt.
                </p>
                <textarea id="modal-notes-textarea" class="input" rows="5" placeholder="Notiz hier eingeben…" style="resize:vertical;font-family:inherit">${esc(item.notes || '')}</textarea>
                <div style="display:flex;justify-content:space-between;align-items:center;margin-top:0.4rem">
                    ${item.notes ? `<button type="button" class="btn btn-ghost btn-sm text-danger" id="btn-delete-note">Notiz entfernen</button>` : '<span></span>'}
                    <div style="display:flex;gap:0.5rem">
                        <button type="button" class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
                        <button type="button" class="btn btn-primary" id="btn-save-note">Speichern</button>
                    </div>
                </div>
            </div>
        `);

        setTimeout(() => {
            const ta = $('#modal-notes-textarea');
            if (ta) {
                ta.focus();
                ta.setSelectionRange(ta.value.length, ta.value.length);
            }
        }, 60);

        $('#btn-save-note')?.addEventListener('click', async () => {
            const notes = ($('#modal-notes-textarea')?.value || '').trim();
            try {
                await apiPost('set_notes', {
                    type: item.type,
                    id: item.id,
                    notes: notes,
                });
                closeModal();
                toast(notes ? 'Notiz gespeichert.' : 'Notiz entfernt.');
                loadCurrentView();
            } catch (err) {
                toast(err.message, 'error');
            }
        });

        $('#btn-delete-note')?.addEventListener('click', async () => {
            try {
                await apiPost('set_notes', {
                    type: item.type,
                    id: item.id,
                    notes: '',
                });
                closeModal();
                toast('Notiz entfernt.');
                loadCurrentView();
            } catch (err) {
                toast(err.message, 'error');
            }
        });
    }

    // File Versions Modal
    async function openVersionsModal(item) {
        openModal(`🕒 Revisionsverlauf – „${esc(item.name)}“`, `
            <div style="text-align:center;padding:1.5rem" id="versions-loading">
                <span class="spinner"></span> Lade Revisionsverlauf…
            </div>
            <div id="versions-content" class="hidden"></div>
        `);

        try {
            const res = await apiGet({ action: 'file_versions', file_id: item.id });
            const data = res.data;
            const versions = data.versions || [];

            const loading = $('#versions-loading');
            const content = $('#versions-content');
            if (loading) loading.classList.add('hidden');
            if (!content) return;
            content.classList.remove('hidden');

            let html = `
                <div style="margin-bottom:0.85rem">
                    <div class="version-list-item is-current">
                        <div>
                            <strong>Aktuelle Version</strong>
                            <div class="muted small">
                                📅 ${esc((data.current_date || '').replace('T', ' ').slice(0, 16))} · 📦 ${formatBytes(data.current_size)}
                                ${data.current_sha ? `· <span title="SHA-256: ${esc(data.current_sha)}">🔒 ${esc(data.current_sha.slice(0, 8))}…</span>` : ''}
                            </div>
                        </div>
                        <span class="badge" style="background:var(--primary);color:#fff">Aktiv</span>
                    </div>
                </div>
            `;

            if (versions.length === 0) {
                html += `
                    <p class="muted small" style="text-align:center;padding:1rem 0">
                        Noch keine früheren Versionen vorhanden.<br>
                        Sobald die Datei überschrieben oder im Editor gespeichert wird, entsteht hier automatisch ein Revisionsverlauf (bis zu 10 Versionen).
                    </p>
                `;
            } else {
                html += `<div style="font-size:0.82rem;font-weight:600;margin-bottom:0.45rem;color:var(--text-muted)">Frühere Versionen (${versions.length}):</div>`;
                html += `<div style="display:flex;flex-direction:column;gap:0.45rem;max-height:260px;overflow-y:auto">`;
                for (const ver of versions) {
                    html += `
                        <div class="version-list-item">
                            <div>
                                <strong>Version ${ver.version_num}</strong>
                                <div class="muted small">
                                    📅 ${esc((ver.created_at || '').replace('T', ' ').slice(0, 16))} · 📦 ${formatBytes(ver.size_bytes)}
                                    ${ver.sha256 ? `· <span title="SHA-256: ${esc(ver.sha256)}">🔒 ${esc(ver.sha256.slice(0, 8))}…</span>` : ''}
                                </div>
                            </div>
                            <div style="display:flex;gap:0.35rem">
                                <a href="api.php?action=download_version&version_id=${ver.id}" class="btn btn-ghost btn-sm" title="Version herunterladen" download>
                                    ⬇️
                                </a>
                                <button type="button" class="btn btn-ghost btn-sm" data-restore-ver="${ver.id}" title="Diese Version als aktuelle Datei wiederherstellen">
                                    ♻️
                                </button>
                                <button type="button" class="btn btn-ghost btn-sm text-danger" data-delete-ver="${ver.id}" title="Diese Version löschen">
                                    🗑️
                                </button>
                            </div>
                        </div>
                    `;
                }
                html += `</div>`;
            }

            content.innerHTML = html;

            $$('[data-restore-ver]', content).forEach((btn) => {
                btn.addEventListener('click', async () => {
                    const vid = btn.dataset.restoreVer;
                    if (!confirm('Möchten Sie diese ältere Version wirklich wiederherstellen? Die aktuelle Datei wird als neue Vorversion gesichert.')) return;
                    try {
                        await apiPost('restore_version', { version_id: Number(vid) });
                        closeModal();
                        toast('Version erfolgreich wiederhergestellt.');
                        loadCurrentView();
                    } catch (err) {
                        toast(err.message, 'error');
                    }
                });
            });

            $$('[data-delete-ver]', content).forEach((btn) => {
                btn.addEventListener('click', async () => {
                    const vid = btn.dataset.deleteVer;
                    if (!confirm('Diese Version endgültig löschen?')) return;
                    try {
                        await apiPost('delete_version', { version_id: Number(vid) });
                        toast('Version gelöscht.');
                        openVersionsModal(item);
                        loadCurrentView();
                    } catch (err) {
                        toast(err.message, 'error');
                    }
                });
            });

        } catch (err) {
            toast(err.message, 'error');
            closeModal();
        }
    }

    // Create / Edit Text File Modal
    $('#btn-new-text')?.addEventListener('click', () => {
        openTextEditorModal(null, 'notiz.md', '');
    });

    $('#btn-new-voice-memo')?.addEventListener('click', () => {
        $('#new-action-menu')?.classList.add('hidden');
        openVoiceMemoModal();
    });

    function openTextEditorModal(fileId, fileName, content, readOnly = false) {
        openModal(fileId ? `Textdatei: ${fileName}` : 'Neue Textdatei erstellen', `
            <form id="text-editor-form">
                ${!fileId ? `
                <div class="form-group">
                    <label>Dateiname</label>
                    <input type="text" name="name" class="input" value="${esc(fileName)}" required>
                </div>` : ''}
                <div class="form-group">
                    <textarea name="content" class="input editor-textarea" ${readOnly ? 'readonly' : ''}>${esc(content)}</textarea>
                </div>
                <div style="display:flex;justify-content:space-between;gap:0.5rem">
                    ${fileId ? `<a class="btn btn-ghost" href="api.php?action=download&id=${fileId}">⬇️ Herunterladen</a>` : '<span></span>'}
                    ${!readOnly ? `<button type="submit" class="btn btn-primary">💾 Speichern</button>` : ''}
                </div>
            </form>
        `, true);

        $('#text-editor-form')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const name = fileId ? fileName : e.target.name.value.trim();
            const text = e.target.content.value;
            try {
                await apiPost('save_text', {
                    folder_id: state.currentFolderId,
                    file_id: fileId,
                    name,
                    content: text,
                });
                closeModal();
                toast('Datei gespeichert.');
                loadCurrentView();
            } catch (err) {
                toast(err.message, 'error');
            }
        });
    }

    // File Preview Modal (Images, Video, Audio, PDF, Text, ZIP, Vault)
    async function openFileModal(file) {
        if (file.is_encrypted) {
            openVaultModal(file);
            return;
        }

        if (file.category === 'zip') {
            openZipModal(file);
            return;
        }

        if (file.category === 'text') {
            try {
                const res = await apiGet({ action: 'read_text', id: file.id });
                const readOnly = !['owner', 'write'].includes(res.permission);
                openTextEditorModal(file.id, res.name, res.content, readOnly);
            } catch (err) {
                toast(err.message, 'error');
            }
            return;
        }

        if (file.category === 'audio') {
            playDockAudio(file);
            return;
        }

        const streamUrl = `api.php?action=download&id=${file.id}&inline=1`;
        const dlUrl = `api.php?action=download&id=${file.id}`;
        let previewHtml = '';

        if (file.category === 'image') {
            previewHtml = `<div class="preview-media-wrap"><img src="${streamUrl}" alt="${esc(file.name)}"></div>`;
        } else if (file.category === 'video') {
            previewHtml = `<div class="preview-media-wrap"><video controls autoplay src="${streamUrl}"></video></div>`;
        } else if (file.category === 'pdf') {
            previewHtml = `<iframe class="preview-pdf-frame" src="${streamUrl}"></iframe>`;
        } else {
            previewHtml = `
                <div class="empty-state" style="margin-bottom:1rem">
                    <div class="empty-state-icon">📄</div>
                    <p class="muted">${esc(file.mime_type)} · ${formatBytes(file.size_bytes)}</p>
                </div>
            `;
        }

        const noteBox = file.notes ? `
            <div style="background:var(--bg-card);border:1px solid var(--border);border-left:3px solid var(--primary);border-radius:4px;padding:0.5rem 0.75rem;margin:0.75rem 0;font-size:0.84rem;display:flex;justify-content:space-between;align-items:flex-start;gap:0.5rem">
                <div>
                    <div style="font-weight:600;font-size:0.75rem;color:var(--text-muted);margin-bottom:0.15rem">📝 Notiz:</div>
                    <div style="white-space:pre-wrap">${esc(file.notes)}</div>
                </div>
                <button type="button" class="btn btn-ghost btn-sm" id="modal-btn-edit-note" title="Notiz bearbeiten">✏️</button>
            </div>
        ` : '';

        openModal(file.name, `
            ${previewHtml}
            ${noteBox}
            <div style="display:flex;justify-content:space-between;align-items:center;margin-top:0.75rem;flex-wrap:wrap;gap:0.5rem">
                <div class="muted small" style="display:flex;align-items:center;gap:0.4rem;flex-wrap:wrap">
                    <span>${formatBytes(file.size_bytes)} · ${esc(file.mime_type)}</span>
                    ${file.color_tag ? `<span class="color-tag-dot color-${esc(file.color_tag)}" title="Tag: ${esc(file.color_tag)}"></span>` : ''}
                    ${file.sha256 ? `<span class="muted" style="cursor:pointer" id="btn-copy-sha" title="SHA-256 in die Zwischenablage kopieren (Klick)">🔒 ${esc(file.sha256.slice(0, 10))}…</span>` : ''}
                </div>
                <div style="display:flex;gap:0.35rem;align-items:center">
                    ${(!file.is_encrypted && (file.category === 'image' || file.category === 'pdf')) ? `<button type="button" class="btn btn-ghost btn-sm" id="modal-btn-ocr">🔍 Text erkennen (OCR)</button>` : ''}
                    ${(!file.is_encrypted && file.category === 'image' && ['owner', 'write'].includes(state.permission)) ? `<button type="button" class="btn btn-ghost btn-sm" id="modal-btn-optimize">🗜️ Optimieren</button>` : ''}
                    ${(file.category === 'image') ? `<button type="button" class="btn btn-ghost btn-sm" id="modal-btn-exif">🧭 EXIF</button>` : ''}
                    ${(!file.is_encrypted && file.category === 'pdf' && ['owner', 'write'].includes(state.permission)) ? `<button type="button" class="btn btn-ghost btn-sm" id="modal-btn-sign">✍️ Signieren</button>` : ''}
                    <button type="button" class="btn btn-ghost btn-sm" id="modal-btn-note">📝 ${file.notes ? 'Notiz' : '+ Notiz'}</button>
                    <button type="button" class="btn btn-ghost btn-sm" id="modal-btn-versions">🕒 Versionen ${file.version_count > 0 ? `(${file.version_count + 1})` : ''}</button>
                    <button type="button" class="btn btn-ghost btn-sm" id="modal-btn-vault">🔒 Verschlüsseln</button>
                    <a class="btn btn-primary btn-sm" href="${dlUrl}">⬇️ Herunterladen</a>
                </div>
            </div>
        `, file.category === 'pdf' || file.category === 'image' || file.category === 'video');

        $('#modal-btn-ocr')?.addEventListener('click', () => {
            closeModal();
            openOcrModal(file);
        });
        $('#modal-btn-optimize')?.addEventListener('click', () => {
            closeModal();
            openImageOptimizeModal(file);
        });
        $('#modal-btn-exif')?.addEventListener('click', () => {
            closeModal();
            openExifModal(file);
        });
        $('#modal-btn-sign')?.addEventListener('click', () => {
            closeModal();
            openPdfSignModal(file);
        });
        $('#modal-btn-vault')?.addEventListener('click', () => {
            openVaultModal(file);
        });
        $('#modal-btn-note')?.addEventListener('click', () => {
            openNotesModal(file);
        });
        $('#modal-btn-edit-note')?.addEventListener('click', () => {
            openNotesModal(file);
        });
        $('#modal-btn-versions')?.addEventListener('click', () => {
            openVersionsModal(file);
        });
        $('#btn-copy-sha')?.addEventListener('click', () => {
            if (file.sha256) {
                navigator.clipboard?.writeText(file.sha256).then(() => {
                    toast('SHA-256 Prüfsumme in die Zwischenablage kopiert.');
                });
            }
        });
    }

    // OCR Text Recognition (Client-side via Tesseract.js & PDF.js)
    async function loadScriptOnce(src) {
        return new Promise((resolve, reject) => {
            if (document.querySelector(`script[src="${src}"]`)) {
                return resolve();
            }
            const s = document.createElement('script');
            s.src = src;
            s.async = true;
            s.onload = () => resolve();
            s.onerror = () => reject(new Error(`Fehler beim Laden von ${src}`));
            document.head.appendChild(s);
        });
    }

    async function ensureTesseract() {
        if (!window.Tesseract) {
            await loadScriptOnce('https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js');
        }
        return window.Tesseract;
    }

    async function ensurePdfJs() {
        if (!window.pdfjsLib) {
            await loadScriptOnce('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js');
            window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        }
        return window.pdfjsLib;
    }

    async function ensurePdfLib() {
        if (!window.PDFLib) {
            await loadScriptOnce('https://cdn.jsdelivr.net/npm/pdf-lib/dist/pdf-lib.min.js');
        }
        return window.PDFLib;
    }

    async function openOcrModal(file) {
        if (activeOcrWorker) {
            try { await activeOcrWorker.terminate(); } catch (_) {}
            activeOcrWorker = null;
        }

        const isPdf = file.category === 'pdf';
        const streamUrl = `api.php?action=download&id=${file.id}&inline=1`;

        openModal(`🔍 Text erkennen (OCR) – ${esc(file.name)}`, `
            <div style="display:flex;flex-direction:column;gap:0.75rem">
                <!-- Toolbar -->
                <div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:0.5rem;padding:0.5rem 0.75rem;background:var(--bg-secondary);border:1px solid var(--border);border-radius:8px">
                    <div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap">
                        <label for="ocr-lang-select" style="font-size:0.82rem;font-weight:600;color:var(--text-muted)">Sprache:</label>
                        <select id="ocr-lang-select" class="input input-sm" style="width:auto;min-width:140px;padding:0.25rem 0.5rem;font-size:0.84rem">
                            <option value="deu" selected>🇩🇪 Deutsch</option>
                            <option value="eng">🇬🇧 Englisch</option>
                            <option value="deu+eng">🇩🇪+🇬🇧 Deu + Eng</option>
                            <option value="fra">🇫🇷 Französisch</option>
                            <option value="spa">🇪🇸 Spanisch</option>
                            <option value="ita">🇮🇹 Italienisch</option>
                        </select>
                        <button type="button" class="btn btn-primary btn-sm" id="btn-ocr-run">▶ Erkennung starten</button>
                    </div>
                    <div id="ocr-status-badge" style="font-size:0.82rem;display:flex;align-items:center;gap:0.4rem;color:var(--text-muted)">
                        <span id="ocr-status-icon">⚪</span> <span id="ocr-status-text">Bereit</span>
                    </div>
                </div>

                <!-- Progress Bar -->
                <div id="ocr-progress-box" class="hidden" style="display:flex;flex-direction:column;gap:0.25rem">
                    <div style="display:flex;justify-content:space-between;font-size:0.78rem;color:var(--text-muted)">
                        <span id="ocr-progress-msg">Initialisiere...</span>
                        <span id="ocr-progress-pct">0%</span>
                    </div>
                    <div style="height:6px;width:100%;background:var(--border);border-radius:3px;overflow:hidden">
                        <div id="ocr-progress-bar" style="height:100%;width:0%;background:var(--primary);transition:width 0.2s ease"></div>
                    </div>
                </div>

                <!-- Split Workspace -->
                <div class="ocr-split-view">
                    <!-- Left: Preview -->
                    <div class="ocr-panel">
                        <div class="ocr-panel-header">
                            <span>Vorschau</span>
                            <span id="ocr-preview-info">${isPdf ? 'PDF Dokument' : 'Bild'}</span>
                        </div>
                        <div class="ocr-panel-body" id="ocr-preview-container">
                            ${isPdf 
                                ? `<canvas id="ocr-canvas" style="max-width:100%;max-height:100%;object-fit:contain;border-radius:4px;box-shadow:0 1px 3px rgba(0,0,0,0.2)"></canvas>`
                                : `<img id="ocr-img" src="${streamUrl}" alt="${esc(file.name)}" style="max-width:100%;max-height:100%;object-fit:contain;border-radius:4px;box-shadow:0 1px 3px rgba(0,0,0,0.2)" />`
                            }
                        </div>
                    </div>

                    <!-- Right: Recognized Text -->
                    <div class="ocr-panel">
                        <div class="ocr-panel-header">
                            <span>Erkannter Text</span>
                            <span id="ocr-stats">0 Zeichen · 0 Wörter</span>
                        </div>
                        <div class="ocr-panel-body" style="padding:0">
                            <textarea id="ocr-text-result" class="ocr-textarea" placeholder="Der erkannte Text erscheint hier…"></textarea>
                        </div>
                    </div>
                </div>

                <!-- Actions Footer -->
                <div style="display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:0.5rem;padding-top:0.4rem;border-top:1px solid var(--border)">
                    <div style="display:flex;gap:0.4rem;flex-wrap:wrap">
                        <button type="button" class="btn btn-ghost btn-sm" id="btn-ocr-copy" disabled>📋 In Zwischenablage</button>
                        <button type="button" class="btn btn-ghost btn-sm" id="btn-ocr-save-txt" disabled>📝 Als .txt speichern</button>
                        <button type="button" class="btn btn-ghost btn-sm" id="btn-ocr-save-note" disabled>📌 Als Notiz anfügen</button>
                    </div>
                    <button type="button" class="btn btn-ghost" id="btn-ocr-close">Schließen</button>
                </div>
            </div>
        `, true);

        const statusIcon = $('#ocr-status-icon');
        const statusText = $('#ocr-status-text');
        const progressBox = $('#ocr-progress-box');
        const progressMsg = $('#ocr-progress-msg');
        const progressPct = $('#ocr-progress-pct');
        const progressBar = $('#ocr-progress-bar');
        const textResult = $('#ocr-text-result');
        const statsEl = $('#ocr-stats');
        const btnRun = $('#btn-ocr-run');
        const btnCopy = $('#btn-ocr-copy');
        const btnSaveTxt = $('#btn-ocr-save-txt');
        const btnSaveNote = $('#btn-ocr-save-note');
        const btnClose = $('#btn-ocr-close');
        const langSelect = $('#ocr-lang-select');
        const previewInfo = $('#ocr-preview-info');

        let isRunning = false;
        let isCanceled = false;

        function updateStats() {
            const val = textResult?.value || '';
            const chars = val.length;
            const words = val.trim() ? val.trim().split(/\s+/).length : 0;
            if (statsEl) statsEl.textContent = `${chars} Zeichen · ${words} Wörter`;
            const hasText = chars > 0;
            if (btnCopy) btnCopy.disabled = !hasText;
            if (btnSaveTxt) btnSaveTxt.disabled = !hasText;
            if (btnSaveNote) btnSaveNote.disabled = !hasText;
        }

        textResult?.addEventListener('input', updateStats);

        function setStatus(text, icon = '⚪') {
            if (statusIcon) statusIcon.textContent = icon;
            if (statusText) statusText.textContent = text;
        }

        function setProgress(msg, percent) {
            if (progressBox) progressBox.classList.remove('hidden');
            if (progressMsg) progressMsg.textContent = msg;
            const p = Math.max(0, Math.min(100, Math.round(percent)));
            if (progressPct) progressPct.textContent = `${p}%`;
            if (progressBar) progressBar.style.width = `${p}%`;
        }

        function translateStatus(s, lang) {
            switch (s) {
                case 'loading tesseract core': return 'Lade OCR-Kern...';
                case 'loaded tesseract core': return 'OCR-Kern geladen';
                case 'loading language traineddata': return `Lade Sprachmodell (${lang})...`;
                case 'loaded language traineddata': return 'Sprachmodell geladen';
                case 'initializing api': return 'Initialisiere OCR-Engine...';
                case 'initialized api': return 'OCR-Engine bereit';
                case 'recognizing text': return 'Analysiere Bild und erkenne Text...';
                default: return s;
            }
        }

        async function runOcr() {
            if (isRunning) return;
            isRunning = true;
            isCanceled = false;
            if (btnRun) btnRun.disabled = true;
            const selectedLang = langSelect?.value || 'deu';

            setStatus('Initialisiere...', '⏳');
            setProgress('Lade OCR-Bibliothek...', 5);

            try {
                const Tesseract = await ensureTesseract();

                if (isPdf) {
                    const pdfjsLib = await ensurePdfJs();
                    setStatus('Lade PDF...', '⏳');
                    setProgress('Lade PDF-Dokument...', 10);

                    const resp = await fetch(streamUrl);
                    if (!resp.ok) throw new Error(`Download fehlgeschlagen (${resp.status})`);
                    const arrayBuffer = await resp.arrayBuffer();

                    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
                    const pdfDoc = await loadingTask.promise;
                    const numPages = pdfDoc.numPages;

                    setProgress(`PDF geladen (${numPages} Seiten). Initialisiere OCR...`, 20);

                    const langs = selectedLang.includes('+') ? selectedLang.split('+') : selectedLang;
                    let currentPage = 1;

                    activeOcrWorker = await Tesseract.createWorker(langs, 1, {
                        logger: (m) => {
                            if (m.status === 'recognizing text') {
                                const basePct = 20 + ((currentPage - 1) / numPages) * 75;
                                const pageProgress = (m.progress || 0) * (75 / numPages);
                                setProgress(`Seite ${currentPage}/${numPages}: Erkenne Text...`, basePct + pageProgress);
                            }
                        }
                    });

                    let fullText = '';

                    for (let p = 1; p <= numPages; p++) {
                        if (isCanceled) break;
                        currentPage = p;
                        if (previewInfo) previewInfo.textContent = `Seite ${p} von ${numPages}`;
                        setProgress(`Verarbeite Seite ${p} von ${numPages}...`, 20 + ((p - 1) / numPages) * 75);

                        const page = await pdfDoc.getPage(p);

                        // Render to canvas
                        const canvas = $('#ocr-canvas');
                        if (canvas) {
                            const viewport = page.getViewport({ scale: 1.8 });
                            canvas.width = viewport.width;
                            canvas.height = viewport.height;
                            const ctx = canvas.getContext('2d');
                            await page.render({ canvasContext: ctx, viewport }).promise;
                        }

                        // Check if digital text is already embedded in PDF
                        const textContent = await page.getTextContent();
                        const rawText = textContent.items.map((it) => it.str).join(' ').trim();

                        let pageExtracted = '';
                        if (rawText.length > 60) {
                            pageExtracted = rawText;
                        } else if (canvas) {
                            const result = await activeOcrWorker.recognize(canvas);
                            pageExtracted = (result?.data?.text || '').trim();
                        }

                        if (pageExtracted) {
                            fullText += (p > 1 ? '\n\n' : '') + `--- [Seite ${p}/${numPages}] ---\n` + pageExtracted;
                            if (textResult) {
                                textResult.value = fullText;
                                updateStats();
                            }
                        }
                    }

                    if (activeOcrWorker) {
                        await activeOcrWorker.terminate();
                        activeOcrWorker = null;
                    }

                } else {
                    // Image OCR
                    setStatus('Erkenne Bildtext...', '⏳');
                    const langs = selectedLang.includes('+') ? selectedLang.split('+') : selectedLang;

                    activeOcrWorker = await Tesseract.createWorker(langs, 1, {
                        logger: (m) => {
                            const trans = translateStatus(m.status, selectedLang);
                            const pct = Math.round((m.progress || 0) * 100);
                            setProgress(trans, pct);
                        }
                    });

                    const imgEl = $('#ocr-img');
                    const ocrSource = imgEl || streamUrl;
                    const res = await activeOcrWorker.recognize(ocrSource);
                    const recognized = (res?.data?.text || '').trim();

                    if (textResult) {
                        textResult.value = recognized;
                        updateStats();
                    }

                    if (activeOcrWorker) {
                        await activeOcrWorker.terminate();
                        activeOcrWorker = null;
                    }
                }

                if (!isCanceled) {
                    setProgress('Fertig!', 100);
                    setStatus('Abgeschlossen', '✅');
                    toast('Texterkennung erfolgreich abgeschlossen!');
                }
            } catch (err) {
                console.error(err);
                setStatus('Fehler', '❌');
                toast(`OCR-Fehler: ${err.message}`, 'error');
            } finally {
                isRunning = false;
                if (btnRun) btnRun.disabled = false;
            }
        }

        btnRun?.addEventListener('click', runOcr);
        langSelect?.addEventListener('change', () => {
            if (!isRunning) runOcr();
        });

        btnCopy?.addEventListener('click', () => {
            const text = textResult?.value || '';
            if (!text) return;
            navigator.clipboard?.writeText(text).then(() => {
                toast('Text in die Zwischenablage kopiert!');
            }).catch(() => {
                toast('Kopieren fehlgeschlagen.', 'error');
            });
        });

        btnSaveTxt?.addEventListener('click', async () => {
            const text = textResult?.value || '';
            if (!text) return;
            const dotIdx = file.name.lastIndexOf('.');
            const base = dotIdx > 0 ? file.name.substring(0, dotIdx) : file.name;
            const defaultName = `${base}_ocr.txt`;
            const fileName = prompt('Name für die Textdatei:', defaultName);
            if (!fileName || !fileName.trim()) return;

            try {
                await apiPost('save_text', {
                    folder_id: state.currentFolderId,
                    name: fileName.trim(),
                    content: text,
                });
                toast(`Datei „${fileName.trim()}“ im Ordner gespeichert!`);
                loadCurrentView();
            } catch (err) {
                toast(err.message, 'error');
            }
        });

        btnSaveNote?.addEventListener('click', async () => {
            const text = textResult?.value || '';
            if (!text) return;
            const existing = (file.notes || '').trim();
            const combined = existing 
                ? `${existing}\n\n[OCR-Text]:\n${text}` 
                : text;

            try {
                await apiPost('set_notes', {
                    type: 'file',
                    id: file.id,
                    notes: combined,
                });
                file.notes = combined;
                toast('OCR-Text als Notiz an die Datei angeheftet!');
                loadCurrentView();
            } catch (err) {
                toast(err.message, 'error');
            }
        });

        btnClose?.addEventListener('click', () => {
            isCanceled = true;
            if (activeOcrWorker) {
                activeOcrWorker.terminate().catch(() => {});
                activeOcrWorker = null;
            }
            closeModal();
        });

        // Auto-run OCR upon modal opening
        setTimeout(() => {
            runOcr();
        }, 150);
    }

    // Batch Rename Modal
    function openBatchRenameModal(items) {
        if (!items || items.length === 0) return;

        openModal(`🏷️ Massen-Umbenennung (${items.length} Elemente)`, `
            <div style="display:flex;flex-direction:column;gap:0.85rem">
                <!-- Mode Tabs -->
                <div class="rename-mode-nav">
                    <button type="button" class="btn btn-sm btn-primary" data-rename-mode="numbering">🔢 Nummerierung</button>
                    <button type="button" class="btn btn-sm btn-ghost" data-rename-mode="replace">🔍 Suchen & Ersetzen</button>
                    <button type="button" class="btn btn-sm btn-ghost" data-rename-mode="affix">➕ Präfix / Suffix</button>
                    <button type="button" class="btn btn-sm btn-ghost" data-rename-mode="case">🔤 Schreibweise</button>
                </div>

                <!-- Mode 1: Numbering & Pattern -->
                <div id="rename-box-numbering" class="form-group-wrap" style="display:grid;grid-template-columns:1fr 1fr;gap:0.5rem">
                    <div class="form-group" style="grid-column:1 / -1">
                        <label class="small text-muted">Muster-Name (Basis)</label>
                        <input type="text" id="rename-base-name" class="input" placeholder="z. B. Urlaub_Kreta" value="Element">
                    </div>
                    <div class="form-group">
                        <label class="small text-muted">Zählerformat</label>
                        <select id="rename-counter-digits" class="input">
                            <option value="1">1, 2, 3 …</option>
                            <option value="2" selected>01, 02, 03 …</option>
                            <option value="3">001, 002, 003 …</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label class="small text-muted">Startwert</label>
                        <input type="number" id="rename-start-num" class="input" value="1" min="0">
                    </div>
                </div>

                <!-- Mode 2: Search & Replace -->
                <div id="rename-box-replace" class="form-group-wrap hidden" style="display:grid;grid-template-columns:1fr 1fr;gap:0.5rem">
                    <div class="form-group">
                        <label class="small text-muted">Suchen nach</label>
                        <input type="text" id="rename-search-str" class="input" placeholder="z. B. IMG_">
                    </div>
                    <div class="form-group">
                        <label class="small text-muted">Ersetzen durch</label>
                        <input type="text" id="rename-replace-str" class="input" placeholder="z. B. Foto_">
                    </div>
                    <div style="grid-column:1 / -1">
                        <label class="checkbox-label small">
                            <input type="checkbox" id="rename-case-sensitive"> Groß-/Kleinschreibung beachten
                        </label>
                    </div>
                </div>

                <!-- Mode 3: Affix (Prefix & Suffix) -->
                <div id="rename-box-affix" class="form-group-wrap hidden" style="display:grid;grid-template-columns:1fr 1fr;gap:0.5rem">
                    <div class="form-group">
                        <label class="small text-muted">Präfix (voranstellen)</label>
                        <input type="text" id="rename-prefix-str" class="input" placeholder="z. B. 2026-11-21_">
                    </div>
                    <div class="form-group">
                        <label class="small text-muted">Suffix (anhängen)</label>
                        <input type="text" id="rename-suffix-str" class="input" placeholder="z. B. _bearbeitet">
                    </div>
                </div>

                <!-- Mode 4: Case -->
                <div id="rename-box-case" class="form-group-wrap hidden">
                    <label class="small text-muted">Groß-/Kleinschreibung anpassen</label>
                    <select id="rename-case-select" class="input">
                        <option value="lower">kleinbuchstaben (foto_01.jpg)</option>
                        <option value="upper">GROSSBUCHSTABEN (FOTO_01.JPG)</option>
                        <option value="title">Wortanfänge Groß (Foto_01.Jpg)</option>
                    </select>
                </div>

                <!-- Preview Area -->
                <div style="border:1px solid var(--border);border-radius:6px;overflow:hidden;background:var(--bg-main)">
                    <div style="padding:0.4rem 0.65rem;background:var(--bg-secondary);border-bottom:1px solid var(--border);display:flex;justify-content:space-between;font-size:0.75rem;font-weight:600;color:var(--text-muted)">
                        <span>Vorschau der Umbenennung</span>
                        <span id="rename-conflict-warning" style="color:#ef4444;font-weight:700"></span>
                    </div>
                    <div style="max-height:190px;overflow-y:auto">
                        <table class="batch-rename-table">
                            <thead>
                                <tr><th>Original</th><th></th><th>Neuer Name</th></tr>
                            </thead>
                            <tbody id="rename-preview-tbody"></tbody>
                        </table>
                    </div>
                </div>

                <!-- Actions -->
                <div style="display:flex;justify-content:space-between;gap:0.5rem;align-items:center;padding-top:0.4rem;border-top:1px solid var(--border)">
                    <button type="button" class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
                    <button type="button" class="btn btn-primary" id="btn-submit-batch-rename">💾 Alle ${items.length} umbenennen</button>
                </div>
            </div>
        `, true);

        let activeMode = 'numbering';

        $$('[data-rename-mode]').forEach((btn) => {
            btn.addEventListener('click', () => {
                activeMode = btn.dataset.renameMode;
                $$('[data-rename-mode]').forEach((b) => {
                    b.classList.toggle('btn-primary', b === btn);
                    b.classList.toggle('btn-ghost', b !== btn);
                });
                ['numbering', 'replace', 'affix', 'case'].forEach((m) => {
                    $(`#rename-box-${m}`)?.classList.toggle('hidden', m !== activeMode);
                });
                updatePreview();
            });
        });

        function computeNewName(originalName, index, isFolder) {
            let ext = '';
            let base = originalName;
            if (!isFolder && originalName.includes('.')) {
                const dot = originalName.lastIndexOf('.');
                ext = originalName.substring(dot);
                base = originalName.substring(0, dot);
            }

            if (activeMode === 'numbering') {
                const pattern = ($('#rename-base-name')?.value || '').trim() || 'Element';
                const digits = Number($('#rename-counter-digits')?.value || 2);
                const start = Number($('#rename-start-num')?.value || 1);
                const num = String(start + index).padStart(digits, '0');
                return `${pattern}_${num}${ext}`;
            }

            if (activeMode === 'replace') {
                const search = $('#rename-search-str')?.value || '';
                const replace = $('#rename-replace-str')?.value || '';
                const caseSensitive = $('#rename-case-sensitive')?.checked;
                if (!search) return originalName;

                let newBase = base;
                if (caseSensitive) {
                    newBase = base.split(search).join(replace);
                } else {
                    const reg = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
                    newBase = base.replace(reg, replace);
                }
                return `${newBase}${ext}`;
            }

            if (activeMode === 'affix') {
                const prefix = $('#rename-prefix-str')?.value || '';
                const suffix = $('#rename-suffix-str')?.value || '';
                return `${prefix}${base}${suffix}${ext}`;
            }

            if (activeMode === 'case') {
                const c = $('#rename-case-select')?.value;
                let newBase = base;
                if (c === 'lower') newBase = base.toLowerCase();
                else if (c === 'upper') newBase = base.toUpperCase();
                else if (c === 'title') newBase = base.replace(/\b\w/g, (l) => l.toUpperCase());
                return `${newBase}${ext}`;
            }

            return originalName;
        }

        function updatePreview() {
            const tbody = $('#rename-preview-tbody');
            if (!tbody) return;

            const seen = new Set();
            let hasDuplicates = false;

            tbody.innerHTML = items.map((it, idx) => {
                const newName = computeNewName(it.name, idx, it.type === 'folder');
                const isDup = seen.has(newName.toLowerCase());
                seen.add(newName.toLowerCase());
                if (isDup) hasDuplicates = true;

                return `
                    <tr>
                        <td class="muted" style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(it.name)}">
                            ${it.type === 'folder' ? '📁' : fileIcon(it)} ${esc(it.name)}
                        </td>
                        <td class="rename-arrow">→</td>
                        <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;color:${isDup ? '#ef4444' : 'var(--text)'}" title="${esc(newName)}">
                            ${esc(newName)} ${isDup ? '<span title="Namenskollision!">⚠️</span>' : ''}
                        </td>
                    </tr>
                `;
            }).join('');

            const warnEl = $('#rename-conflict-warning');
            const submitBtn = $('#btn-submit-batch-rename');
            if (warnEl) warnEl.textContent = hasDuplicates ? '⚠️ Achtung: Mehrere Dateien erhalten denselben Namen!' : '';
            if (submitBtn) submitBtn.disabled = hasDuplicates;
        }

        ['rename-base-name', 'rename-counter-digits', 'rename-start-num',
         'rename-search-str', 'rename-replace-str', 'rename-case-sensitive',
         'rename-prefix-str', 'rename-suffix-str', 'rename-case-select'].forEach((id) => {
            const el = $(`#${id}`);
            el?.addEventListener('input', updatePreview);
            el?.addEventListener('change', updatePreview);
        });

        if (items.length > 0) {
            const f = items[0];
            const dot = f.name.lastIndexOf('.');
            const base = (f.type !== 'folder' && dot > 0) ? f.name.substring(0, dot) : f.name;
            const clean = base.replace(/[\d_-]+$/, '');
            if (clean && $('#rename-base-name')) {
                $('#rename-base-name').value = clean;
            }
        }

        updatePreview();

        $('#btn-submit-batch-rename')?.addEventListener('click', async () => {
            const renames = items.map((it, idx) => ({
                type: it.type,
                id: it.id,
                name: computeNewName(it.name, idx, it.type === 'folder'),
            }));

            try {
                toast('Benenne Elemente um…');
                const res = await apiPost('batch_rename', { renames });
                closeModal();
                toast(`${res.renamed} Elemente erfolgreich umbenannt!`);
                state.selected.clear();
                updateBulkToolbar();
                loadCurrentView();
            } catch (err) {
                toast(err.message, 'error');
            }
        });
    }

    // Client-side Image Optimizer Modal (WebP, Resize & Compression)
    async function openImageOptimizeModal(file) {
        const streamUrl = `api.php?action=download&id=${file.id}&inline=1`;

        openModal(`🗜️ Bild optimieren – ${esc(file.name)}`, `
            <div style="display:flex;flex-direction:column;gap:0.75rem">
                <!-- Settings Toolbar -->
                <div style="display:flex;flex-wrap:wrap;gap:0.75rem;padding:0.6rem 0.85rem;background:var(--bg-secondary);border:1px solid var(--border);border-radius:8px;align-items:center;justify-content:space-between">
                    <div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap">
                        <label style="font-size:0.82rem;font-weight:600;color:var(--text-muted)">Format:</label>
                        <select id="opt-format-select" class="input input-sm" style="width:auto">
                            <option value="image/webp" selected>WebP (Klein & modern)</option>
                            <option value="image/jpeg">JPEG (Standard)</option>
                            <option value="image/png">PNG (Verlustfrei)</option>
                        </select>

                        <label style="font-size:0.82rem;font-weight:600;color:var(--text-muted);margin-left:0.5rem">Max. Breite:</label>
                        <select id="opt-res-select" class="input input-sm" style="width:auto">
                            <option value="0" selected>Originalgröße</option>
                            <option value="2560">2K (2560 px)</option>
                            <option value="1920">Full HD (1920 px)</option>
                            <option value="1280">Web / HD (1280 px)</option>
                            <option value="800">Thumbnail (800 px)</option>
                        </select>
                    </div>

                    <div style="display:flex;align-items:center;gap:0.5rem" id="opt-quality-wrap">
                        <label style="font-size:0.82rem;font-weight:600;color:var(--text-muted)">Qualität:</label>
                        <input type="range" id="opt-quality-slider" min="10" max="100" value="82" style="width:110px">
                        <span id="opt-quality-val" style="font-size:0.82rem;font-weight:700;min-width:32px">82%</span>
                    </div>
                </div>

                <!-- Preview & Savings Comparison -->
                <div class="optimize-compare-wrap">
                    <div class="optimize-preview-box">
                        <div style="font-size:0.75rem;font-weight:600;color:var(--text-muted);margin-bottom:0.35rem">
                            Original: <strong>${formatBytes(file.size_bytes)}</strong>
                        </div>
                        <img id="opt-orig-img" src="${streamUrl}" alt="Original">
                    </div>
                    <div class="optimize-preview-box">
                        <div style="font-size:0.75rem;font-weight:600;margin-bottom:0.35rem;display:flex;align-items:center;gap:0.4rem">
                            <span>Neu: <strong id="opt-new-size">Berechne…</strong></span>
                            <span id="opt-savings-pill" class="savings-pill hidden">-0%</span>
                        </div>
                        <img id="opt-preview-img" alt="Optimiert">
                    </div>
                </div>

                <!-- Action Footer -->
                <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:0.5rem;padding-top:0.4rem;border-top:1px solid var(--border)">
                    <button type="button" class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
                    <div style="display:flex;gap:0.4rem">
                        <button type="button" class="btn btn-ghost" id="btn-opt-replace">Original ersetzen</button>
                        <button type="button" class="btn btn-primary" id="btn-opt-save-new">Als neue Datei speichern</button>
                    </div>
                </div>
            </div>
        `, true);

        const formatSelect = $('#opt-format-select');
        const resSelect = $('#opt-res-select');
        const qualitySlider = $('#opt-quality-slider');
        const qualityVal = $('#opt-quality-val');
        const qualityWrap = $('#opt-quality-wrap');
        const newSizeLbl = $('#opt-new-size');
        const savingsPill = $('#opt-savings-pill');
        const previewImg = $('#opt-preview-img');
        const btnSaveNew = $('#btn-opt-save-new');
        const btnReplace = $('#btn-opt-replace');

        let currentBlob = null;
        let loadedImg = new Image();
        loadedImg.crossOrigin = 'anonymous';

        toast('Lade Bild für Optimierung…');
        loadedImg.src = streamUrl;

        await new Promise((resolve) => {
            loadedImg.onload = resolve;
            loadedImg.onerror = () => {
                toast('Bild konnte nicht geladen werden.', 'error');
                resolve();
            };
        });

        async function processImage() {
            if (!loadedImg.naturalWidth) return;

            const format = formatSelect?.value || 'image/webp';
            const quality = Number(qualitySlider?.value || 82) / 100;
            const maxW = Number(resSelect?.value || 0);

            if (qualityWrap) qualityWrap.style.display = format === 'image/png' ? 'none' : 'flex';

            let targetW = loadedImg.naturalWidth;
            let targetH = loadedImg.naturalHeight;

            if (maxW > 0 && targetW > maxW) {
                targetH = Math.round((maxW / targetW) * targetH);
                targetW = maxW;
            }

            const canvas = document.createElement('canvas');
            canvas.width = targetW;
            canvas.height = targetH;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(loadedImg, 0, 0, targetW, targetH);

            currentBlob = await new Promise((res) => canvas.toBlob(res, format, quality));
            if (!currentBlob) return;

            const newUrl = URL.createObjectURL(currentBlob);
            if (previewImg) previewImg.src = newUrl;

            if (newSizeLbl) newSizeLbl.textContent = formatBytes(currentBlob.size);

            const origSize = file.size_bytes;
            const newSize = currentBlob.size;
            const savings = origSize > 0 ? Math.round(((origSize - newSize) / origSize) * 100) : 0;

            if (savingsPill) {
                savingsPill.classList.remove('hidden');
                if (savings > 0) {
                    savingsPill.textContent = `-${savings}% kleiner!`;
                    savingsPill.style.background = 'rgba(16, 185, 129, 0.15)';
                    savingsPill.style.color = '#10b981';
                } else {
                    savingsPill.textContent = `+${Math.abs(savings)}%`;
                    savingsPill.style.background = 'rgba(239, 68, 68, 0.15)';
                    savingsPill.style.color = '#ef4444';
                }
            }
        }

        formatSelect?.addEventListener('change', processImage);
        resSelect?.addEventListener('change', processImage);
        qualitySlider?.addEventListener('input', () => {
            if (qualityVal) qualityVal.textContent = `${qualitySlider.value}%`;
            processImage();
        });

        await processImage();

        function getTargetExtension(mime) {
            if (mime === 'image/webp') return '.webp';
            if (mime === 'image/jpeg') return '.jpg';
            if (mime === 'image/png') return '.png';
            return '.webp';
        }

        async function saveOptimized(replace = false) {
            if (!currentBlob) return;

            const format = formatSelect?.value || 'image/webp';
            const ext = getTargetExtension(format);

            let targetName = file.name;
            if (!replace) {
                const dot = file.name.lastIndexOf('.');
                const base = dot > 0 ? file.name.substring(0, dot) : file.name;
                targetName = `${base}_opt${ext}`;
            } else if (!targetName.toLowerCase().endsWith(ext)) {
                const dot = targetName.lastIndexOf('.');
                const base = dot > 0 ? targetName.substring(0, dot) : targetName;
                targetName = `${base}${ext}`;
            }

            const newFile = new File([currentBlob], targetName, { type: format });
            closeModal();
            toast(`Lade optimiertes Bild hoch: „${targetName}“…`);
            await uploadFileEntries([{ file: newFile }], state.currentFolderId);
        }

        btnSaveNew?.addEventListener('click', () => saveOptimized(false));
        btnReplace?.addEventListener('click', () => {
            if (confirm(`Möchten Sie das Original „${file.name}“ wirklich durch die optimierte Version ersetzen? (Das Original wird automatisch als Revision archiviert).`)) {
                saveOptimized(true);
            }
        });
    }

    // Storage Radar Modal (Cumulative folder sizes & category breakdown)
    async function openStorageAnalysisModal() {
        openModal('📊 Speicherplatz-Radar', `
            <div id="storage-radar-loading" style="text-align:center;padding:2rem">
                <span class="spinner"></span> Analysiere Speicherbelegung…
            </div>
            <div id="storage-radar-content" class="hidden"></div>
        `, true);

        try {
            const res = await apiGet({ action: 'storage_analysis' });
            const data = res.data;
            const loadEl = $('#storage-radar-loading');
            const contEl = $('#storage-radar-content');
            if (loadEl) loadEl.classList.add('hidden');
            if (!contEl) return;
            contEl.classList.remove('hidden');

            const totalBytes = data.total_bytes || 0;
            const categories = data.categories || [];
            const largestFolders = data.largest_folders || [];
            const largestFiles = data.largest_files || [];

            const meterSegments = categories.map((c) => `
                <div class="storage-segment" style="width:${c.percent}%;background:${c.color}" title="${c.name}: ${formatBytes(c.bytes)} (${c.percent}%)"></div>
            `).join('');

            const legendHtml = categories.map((c) => `
                <div class="radar-legend-item">
                    <span class="radar-legend-dot" style="background:${c.color}"></span>
                    <span>${c.icon} <strong>${esc(c.name)}</strong>: ${formatBytes(c.bytes)} <span class="muted small">(${c.percent}%)</span></span>
                </div>
            `).join('');

            const folderRows = largestFolders.map((f, idx) => `
                <tr style="cursor:pointer" data-radar-folder="${f.id}" title="Zu diesem Ordner navigieren">
                    <td style="width:28px"><span class="radar-rank-badge">${idx + 1}</span></td>
                    <td>
                        <div>📁 <strong>${esc(f.name)}</strong></div>
                        <div class="muted small">${esc(f.path)}</div>
                    </td>
                    <td style="text-align:right;white-space:nowrap">
                        <strong>${formatBytes(f.bytes)}</strong>
                        <div class="muted small">${f.percent}%</div>
                    </td>
                </tr>
            `).join('');

            const fileRows = largestFiles.map((fl, idx) => `
                <tr style="cursor:pointer" data-radar-file="${fl.id}" title="Datei öffnen / Vorschau">
                    <td style="width:28px"><span class="radar-rank-badge">${idx + 1}</span></td>
                    <td>
                        <div>${fileIcon(fl)} <strong>${esc(fl.name)}</strong></div>
                        <div class="muted small">in ${esc(fl.folder_name)}</div>
                    </td>
                    <td style="text-align:right;white-space:nowrap">
                        <strong>${formatBytes(fl.size_bytes)}</strong>
                    </td>
                </tr>
            `).join('');

            contEl.innerHTML = `
                <!-- Total Header -->
                <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:0.5rem;padding:0.6rem 0.85rem;background:var(--bg-secondary);border:1px solid var(--border);border-radius:8px">
                    <div>
                        <div class="muted small">Gesamter belegter Speicher:</div>
                        <div style="font-size:1.4rem;font-weight:700;color:var(--primary)">${formatBytes(totalBytes)}</div>
                    </div>
                    <div style="text-align:right" class="muted small">
                        <div><strong>${data.total_files.toLocaleString('de-DE')}</strong> Dateien</div>
                        <div><strong>${data.total_folders.toLocaleString('de-DE')}</strong> Ordner</div>
                    </div>
                </div>

                <!-- Storage Meter Bar -->
                <div class="storage-meter">${meterSegments || '<div class="storage-segment" style="width:100%;background:#6b7280"></div>'}</div>

                <!-- Legend -->
                <div class="radar-legend">${legendHtml}</div>

                <!-- Split Cards: Largest Folders & Largest Files -->
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem" class="radar-grid-wrap">
                    <!-- Folders Card -->
                    <div style="border:1px solid var(--border);border-radius:8px;overflow:hidden;background:var(--bg-card)">
                        <div style="padding:0.45rem 0.75rem;background:var(--bg-secondary);border-bottom:1px solid var(--border);font-size:0.8rem;font-weight:600;display:flex;justify-content:space-between">
                            <span>📁 Größte Ordner</span>
                            <span class="muted small">Klick = Öffnen</span>
                        </div>
                        <div style="max-height:260px;overflow-y:auto">
                            <table class="batch-rename-table">
                                <tbody>${folderRows || '<tr><td colspan="3" class="muted small" style="text-align:center;padding:1rem">Keine Ordner vorhanden.</td></tr>'}</tbody>
                            </table>
                        </div>
                    </div>

                    <!-- Files Card -->
                    <div style="border:1px solid var(--border);border-radius:8px;overflow:hidden;background:var(--bg-card)">
                        <div style="padding:0.45rem 0.75rem;background:var(--bg-secondary);border-bottom:1px solid var(--border);font-size:0.8rem;font-weight:600;display:flex;justify-content:space-between">
                            <span>📄 Größte Dateien</span>
                            <span class="muted small">Klick = Vorschau</span>
                        </div>
                        <div style="max-height:260px;overflow-y:auto">
                            <table class="batch-rename-table">
                                <tbody>${fileRows || '<tr><td colspan="3" class="muted small" style="text-align:center;padding:1rem">Keine Dateien vorhanden.</td></tr>'}</tbody>
                            </table>
                        </div>
                    </div>
                </div>
            `;

            $$('[data-radar-folder]', contEl).forEach((row) => {
                row.addEventListener('click', () => {
                    const fid = Number(row.dataset.radarFolder);
                    closeModal();
                    state.view = 'files';
                    state.currentFolderId = fid;
                    state.search = '';
                    $('#search-input').value = '';
                    setActiveNavView('files');
                    loadCurrentView();
                });
            });

            $$('[data-radar-file]', contEl).forEach((row) => {
                row.addEventListener('click', () => {
                    const flId = Number(row.dataset.radarFile);
                    const flObj = largestFiles.find((f) => f.id === flId);
                    if (flObj) {
                        closeModal();
                        openFileModal(flObj);
                    }
                });
            });

        } catch (err) {
            toast(`Fehler beim Laden des Radars: ${err.message}`, 'error');
            closeModal();
        }
    }

    // EXIF & GPS Metadata Viewer & Privacy Sanitizer
    async function openExifModal(file) {
        openModal(`🧭 EXIF & Metadaten: ${esc(file.name)}`, `
            <div id="exif-modal-content">
                <div style="text-align:center;padding:2rem">
                    <span class="spinner"></span> Lese Metadaten…
                </div>
            </div>
        `);

        try {
            const res = await apiGet({ action: 'get_exif', id: file.id });
            const contentEl = $('#exif-modal-content');
            if (!contentEl) return;

            const data = res.data;
            if (!data || !data.has_exif) {
                contentEl.innerHTML = `
                    <div style="text-align:center;padding:2rem;color:var(--text-muted)">
                        <div style="font-size:2.5rem;margin-bottom:0.75rem">📷</div>
                        <p style="font-weight:600;margin-bottom:0.35rem">Keine EXIF-Metadaten vorhanden</p>
                        <p class="small">Dieses Bild enthält keine Kamera- oder Standortdaten (möglicherweise bereits bereinigt oder Screenshots/Webgrafiken).</p>
                    </div>
                `;
                return;
            }

            const tags = data.all_tags || {};
            let rowsHtml = '';
            for (const [k, v] of Object.entries(tags)) {
                if (v !== null && v !== undefined && v !== '') {
                    rowsHtml += `<tr><td>${esc(k)}</td><td>${esc(String(v))}</td></tr>`;
                }
            }

            let gpsHtml = '';
            if (data.gps) {
                gpsHtml = `
                    <tr>
                        <td>GPS-Standort</td>
                        <td>
                            <span style="font-family:monospace">${esc(String(data.gps.latitude))}, ${esc(String(data.gps.longitude))}</span>
                            <a href="${esc(data.gps.maps_url)}" target="_blank" rel="noopener noreferrer" class="btn btn-outline btn-xs" style="margin-left:0.5rem;text-decoration:none">
                                🗺️ Auf Karte anzeigen
                            </a>
                        </td>
                    </tr>
                `;
            }

            contentEl.innerHTML = `
                <table class="exif-table">
                    <tbody>
                        ${rowsHtml}
                        ${gpsHtml}
                    </tbody>
                </table>
                <div style="margin-top:1.5rem;padding-top:1rem;border-top:1px solid var(--border)">
                    <div style="font-weight:600;margin-bottom:0.25rem">🛡️ Privacy-Filter / Metadaten bereinigen</div>
                    <div class="muted small" style="margin-bottom:0.75rem">
                        Entfernt alle Kamera-Tags, Zeitstempel und GPS-Koordinaten für maximale Privatsphäre.
                    </div>
                    <div style="display:flex;gap:0.5rem;flex-wrap:wrap">
                        <button type="button" class="btn btn-secondary btn-sm" id="btn-exif-clean-copy">
                            📄 Als bereinigte Kopie speichern
                        </button>
                        ${!file.is_locked ? `
                        <button type="button" class="btn btn-primary btn-sm" id="btn-exif-clean-replace">
                            ✨ Original bereinigen
                        </button>
                        ` : ''}
                    </div>
                </div>
            `;

            const doStrip = async (replace) => {
                try {
                    contentEl.innerHTML = `<div style="text-align:center;padding:2rem"><span class="spinner"></span> Bereinige Metadaten…</div>`;
                    const stripRes = await apiPost('strip_exif', { id: file.id, replace: replace });
                    toast(replace ? 'Metadaten erfolgreich aus dem Original entfernt.' : `Bereinigte Kopie „${stripRes.result.name}“ erstellt.`);
                    closeModal();
                    loadCurrentView();
                } catch (err) {
                    toast(err.message, 'error');
                    closeModal();
                }
            };

            $('#btn-exif-clean-copy')?.addEventListener('click', () => doStrip(false));
            $('#btn-exif-clean-replace')?.addEventListener('click', () => doStrip(true));
        } catch (err) {
            toast(`Fehler beim Lesen der Metadaten: ${err.message}`, 'error');
            closeModal();
        }
    }

    // Voice Memo Recorder Modal
    function openVoiceMemoModal() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            toast('Mikrofon-Aufnahme wird von diesem Browser nicht unterstützt oder ist blockiert.', 'error');
            return;
        }

        const now = new Date();
        const dateStr = now.toISOString().slice(0, 10);
        const timeStr = `${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}`;
        const defaultName = `Sprachnotiz_${dateStr}_${timeStr}.webm`;

        openModal('🎙️ Sprachnotiz aufnehmen', `
            <div style="text-align:center;padding:1rem 0 1.5rem">
                <div class="voice-recorder-wrap" style="display:flex;flex-direction:column;align-items:center;gap:1rem">
                    <button type="button" class="record-pulse-btn" id="btn-record-toggle" title="Aufnahme starten">
                        🎙️
                    </button>
                    <div style="font-size:1.5rem;font-weight:700;font-variant-numeric:tabular-nums;color:var(--text-main)" id="record-timer">
                        00:00
                    </div>
                    <div class="muted small" id="record-status">Klicken Sie auf das Mikrofon, um die Aufnahme zu starten.</div>
                </div>

                <audio id="record-audio-preview" controls class="hidden" style="width:100%;max-width:360px;margin:1.25rem auto 0"></audio>

                <div style="margin-top:1.25rem;text-align:left">
                    <label style="font-size:0.85rem;font-weight:600;display:block;margin-bottom:0.35rem">Dateiname</label>
                    <input type="text" class="input" id="record-filename" value="${esc(defaultName)}" style="width:100%">
                </div>

                <div style="margin-top:1.25rem;display:flex;justify-content:flex-end;gap:0.5rem">
                    <button type="button" class="btn btn-secondary btn-sm" id="btn-record-cancel">Abbrechen</button>
                    <button type="button" class="btn btn-primary btn-sm" id="btn-record-save" disabled>💾 Sprachnotiz speichern</button>
                </div>
            </div>
        `);

        let mediaRecorder = null;
        let audioChunks = [];
        let audioBlob = null;
        let timerInterval = null;
        let secondsElapsed = 0;
        let isRecording = false;

        const btnToggle = $('#btn-record-toggle');
        const timerEl = $('#record-timer');
        const statusEl = $('#record-status');
        const audioPreview = $('#record-audio-preview');
        const btnSave = $('#btn-record-save');
        const btnCancel = $('#btn-record-cancel');
        const nameInput = $('#record-filename');

        function formatTime(sec) {
            const m = Math.floor(sec / 60).toString().padStart(2, '0');
            const s = (sec % 60).toString().padStart(2, '0');
            return `${m}:${s}`;
        }

        function stopTracks() {
            if (timerInterval) {
                clearInterval(timerInterval);
                timerInterval = null;
            }
            if (activeVoiceStream) {
                activeVoiceStream.getTracks().forEach((t) => t.stop());
                activeVoiceStream = null;
            }
        }

        async function startRecording() {
            try {
                activeVoiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
                let mimeType = 'audio/webm;codecs=opus';
                if (!window.MediaRecorder || !MediaRecorder.isTypeSupported(mimeType)) {
                    mimeType = (window.MediaRecorder && MediaRecorder.isTypeSupported('audio/webm')) ? 'audio/webm' : '';
                }
                mediaRecorder = mimeType ? new MediaRecorder(activeVoiceStream, { mimeType }) : new MediaRecorder(activeVoiceStream);
                audioChunks = [];

                mediaRecorder.ondataavailable = (e) => {
                    if (e.data && e.data.size > 0) audioChunks.push(e.data);
                };

                mediaRecorder.onstop = () => {
                    audioBlob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
                    const url = URL.createObjectURL(audioBlob);
                    audioPreview.src = url;
                    audioPreview.classList.remove('hidden');
                    btnSave.disabled = false;
                    statusEl.textContent = 'Aufnahme beendet. Sie können die Notiz jetzt anhören und speichern.';
                };

                mediaRecorder.start(250);
                isRecording = true;
                btnToggle.classList.add('recording');
                btnToggle.textContent = '⏹️';
                btnToggle.title = 'Aufnahme beenden';
                statusEl.textContent = 'Aufnahme läuft…';
                secondsElapsed = 0;
                timerEl.textContent = '00:00';
                timerInterval = setInterval(() => {
                    secondsElapsed++;
                    timerEl.textContent = formatTime(secondsElapsed);
                }, 1000);
            } catch (err) {
                toast(`Mikrofon-Zugriff verweigert oder nicht verfügbar: ${err.message}`, 'error');
            }
        }

        function stopRecording() {
            if (mediaRecorder && mediaRecorder.state !== 'inactive') {
                mediaRecorder.stop();
            }
            stopTracks();
            isRecording = false;
            btnToggle.classList.remove('recording');
            btnToggle.textContent = '🎙️';
            btnToggle.title = 'Neue Aufnahme starten';
        }

        btnToggle?.addEventListener('click', () => {
            if (isRecording) {
                stopRecording();
            } else {
                startRecording();
            }
        });

        btnSave?.addEventListener('click', async () => {
            if (!audioBlob) return;
            const filename = (nameInput.value || 'Sprachnotiz.webm').trim();
            stopTracks();
            try {
                btnSave.disabled = true;
                btnSave.textContent = 'Wird gespeichert…';
                const fileObj = new File([audioBlob], filename, { type: audioBlob.type || 'audio/webm' });
                closeModal();
                await uploadFileEntries([{ file: fileObj, relativePath: '' }], state.currentFolderId);
                toast(`Sprachnotiz „${filename}“ erfolgreich gespeichert.`);
            } catch (err) {
                toast(`Fehler beim Speichern der Sprachnotiz: ${err.message}`, 'error');
            }
        });

        btnCancel?.addEventListener('click', () => {
            stopTracks();
            closeModal();
        });
    }

    // PDF Digital Signature Workspace Modal
    async function openPdfSignModal(file) {
        openModal(`✍️ PDF digital signieren: ${esc(file.name)}`, `
            <div id="pdf-sign-container">
                <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.5rem;padding:0.5rem 0.75rem;background:var(--bg-secondary);border:1px solid var(--border);border-radius:8px;margin-bottom:0.75rem">
                    <div style="display:flex;align-items:center;gap:0.4rem">
                        <button type="button" class="btn btn-ghost btn-sm" id="btn-pdf-sig-prev" title="Vorherige Seite">◀</button>
                        <span class="small" style="font-weight:600">Seite <span id="pdf-sig-cur-page">1</span> von <span id="pdf-sig-total-pages">1</span></span>
                        <button type="button" class="btn btn-ghost btn-sm" id="btn-pdf-sig-next" title="Nächste Seite">▶</button>
                    </div>
                    <div class="muted small">
                        1. Signatur zeichnen · 2. Signaturfeld an die richtige Stelle ziehen · 3. Speichern
                    </div>
                </div>

                <div style="display:grid;grid-template-columns:1fr 320px;gap:1rem;align-items:start;" class="pdf-sign-layout">
                    <!-- PDF Page Preview Viewport -->
                    <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:0.5rem;display:flex;justify-content:center;overflow:auto;max-height:55vh;">
                        <div id="pdf-sign-viewport" style="position:relative;display:inline-block;box-shadow:0 2px 8px rgba(0,0,0,0.15);background:#fff;user-select:none;">
                            <canvas id="pdf-sign-canvas" style="display:block;max-width:100%;height:auto;"></canvas>
                            <div id="pdf-sig-draggable" class="signature-drag-box hidden" style="position:absolute;left:20px;top:20px;width:160px;height:60px;border:2px dashed #2563eb;background:rgba(37,99,235,0.1);cursor:move;touch-action:none;display:flex;align-items:center;justify-content:center;z-index:10;">
                                <img id="pdf-sig-preview-img" style="max-width:100%;max-height:100%;pointer-events:none;" alt="Unterschrift">
                                <div style="position:absolute;bottom:-18px;left:50%;transform:translateX(-50%);font-size:10px;color:#2563eb;font-weight:700;white-space:nowrap;background:rgba(255,255,255,0.9);padding:1px 4px;border-radius:3px;">✥ Platzieren</div>
                            </div>
                        </div>
                    </div>

                    <!-- Signature Pad Controls -->
                    <div style="display:flex;flex-direction:column;gap:0.75rem">
                        <div>
                            <label style="font-size:0.85rem;font-weight:600;display:block;margin-bottom:0.35rem">Unterschrift zeichnen</label>
                            <div style="border:1px solid var(--border);border-radius:6px;background:#ffffff;overflow:hidden;box-shadow:inset 0 1px 3px rgba(0,0,0,0.05);">
                                <canvas id="pdf-pad-canvas" width="320" height="130" style="display:block;width:100%;height:130px;cursor:crosshair;touch-action:none;background:#ffffff;"></canvas>
                            </div>
                        </div>

                        <div style="display:flex;align-items:center;justify-content:space-between;gap:0.5rem">
                            <div style="display:flex;align-items:center;gap:0.35rem">
                                <button type="button" class="btn btn-xs btn-outline" id="btn-sig-color-navy" style="font-weight:600;color:#0f172a">Dunkelblau</button>
                                <button type="button" class="btn btn-xs btn-ghost" id="btn-sig-color-black" style="font-weight:600;color:#000000">Schwarz</button>
                            </div>
                            <button type="button" class="btn btn-ghost btn-xs text-danger" id="btn-sig-clear">🧹 Löschen</button>
                        </div>

                        <div style="font-size:0.85rem">
                            <label style="display:flex;align-items:center;gap:0.4rem;cursor:pointer">
                                <input type="checkbox" id="chk-sig-add-date" checked>
                                <span>Datum automatisch einfügen</span>
                            </label>
                        </div>

                        <div style="margin-top:auto;padding-top:1rem;border-top:1px solid var(--border);display:flex;flex-direction:column;gap:0.5rem">
                            <button type="button" class="btn btn-primary" id="btn-pdf-sig-save" disabled>
                                ✍️ Signierte PDF speichern
                            </button>
                            <button type="button" class="btn btn-secondary btn-sm" id="btn-pdf-sig-cancel">
                                Abbrechen
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `, true);

        let pdfDoc = null;
        let pdfArrayBuffer = null;
        let currentPdfPage = 1;
        let totalPdfPages = 1;

        // Signature Pad Drawing Logic
        const padCanvas = $('#pdf-pad-canvas');
        if (!padCanvas) return;
        const padCtx = padCanvas.getContext('2d');
        let isDrawing = false;
        let hasDrawn = false;
        let strokeColor = '#0f172a';

        padCtx.lineWidth = 2.5;
        padCtx.lineCap = 'round';
        padCtx.lineJoin = 'round';
        padCtx.strokeStyle = strokeColor;

        function getPadPos(e) {
            const rect = padCanvas.getBoundingClientRect();
            const scaleX = padCanvas.width / rect.width;
            const scaleY = padCanvas.height / rect.height;
            return {
                x: (e.clientX - rect.left) * scaleX,
                y: (e.clientY - rect.top) * scaleY,
            };
        }

        padCanvas.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            padCanvas.setPointerCapture(e.pointerId);
            isDrawing = true;
            const pos = getPadPos(e);
            padCtx.beginPath();
            padCtx.moveTo(pos.x, pos.y);
        });

        padCanvas.addEventListener('pointermove', (e) => {
            if (!isDrawing) return;
            e.preventDefault();
            const pos = getPadPos(e);
            padCtx.lineTo(pos.x, pos.y);
            padCtx.stroke();
            hasDrawn = true;
        });

        function generateSignatureDataUrl() {
            if (!hasDrawn) return null;
            const addDate = $('#chk-sig-add-date')?.checked;
            const offCanvas = document.createElement('canvas');
            const w = padCanvas.width;
            const h = addDate ? padCanvas.height + 25 : padCanvas.height;
            offCanvas.width = w;
            offCanvas.height = h;
            const offCtx = offCanvas.getContext('2d');

            offCtx.drawImage(padCanvas, 0, 0);

            if (addDate) {
                const today = new Date().toLocaleDateString('de-DE');
                offCtx.font = '12px sans-serif';
                offCtx.fillStyle = strokeColor;
                offCtx.fillText(`Datum: ${today}`, 8, padCanvas.height + 18);
            }

            return offCanvas.toDataURL('image/png');
        }

        function updateSignaturePreview() {
            const dataUrl = generateSignatureDataUrl();
            if (!dataUrl) return;
            const dragBox = $('#pdf-sig-draggable');
            const previewImg = $('#pdf-sig-preview-img');
            const btnSave = $('#btn-pdf-sig-save');
            if (dragBox && previewImg) {
                previewImg.src = dataUrl;
                dragBox.classList.remove('hidden');
                if (btnSave) btnSave.disabled = false;
            }
        }

        const finishStroke = (e) => {
            if (!isDrawing) return;
            isDrawing = false;
            try { padCanvas.releasePointerCapture(e.pointerId); } catch (_) {}
            if (hasDrawn) {
                updateSignaturePreview();
            }
        };

        padCanvas.addEventListener('pointerup', finishStroke);
        padCanvas.addEventListener('pointercancel', finishStroke);

        $('#chk-sig-add-date')?.addEventListener('change', () => {
            if (hasDrawn) updateSignaturePreview();
        });

        $('#btn-sig-color-navy')?.addEventListener('click', () => {
            strokeColor = '#0f172a';
            padCtx.strokeStyle = strokeColor;
            $('#btn-sig-color-navy').classList.add('btn-outline');
            $('#btn-sig-color-navy').classList.remove('btn-ghost');
            $('#btn-sig-color-black').classList.remove('btn-outline');
            $('#btn-sig-color-black').classList.add('btn-ghost');
        });

        $('#btn-sig-color-black')?.addEventListener('click', () => {
            strokeColor = '#000000';
            padCtx.strokeStyle = strokeColor;
            $('#btn-sig-color-black').classList.add('btn-outline');
            $('#btn-sig-color-black').classList.remove('btn-ghost');
            $('#btn-sig-color-navy').classList.remove('btn-outline');
            $('#btn-sig-color-navy').classList.add('btn-ghost');
        });

        $('#btn-sig-clear')?.addEventListener('click', () => {
            padCtx.clearRect(0, 0, padCanvas.width, padCanvas.height);
            hasDrawn = false;
            $('#pdf-sig-draggable')?.classList.add('hidden');
            const btnSave = $('#btn-pdf-sig-save');
            if (btnSave) btnSave.disabled = true;
        });

        // Draggable Signature Box in Viewport
        const dragBox = $('#pdf-sig-draggable');
        const viewport = $('#pdf-sign-viewport');
        let isDragging = false;
        let dragStartX = 0, dragStartY = 0;
        let origLeft = 20, origTop = 20;

        dragBox.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            isDragging = true;
            dragBox.setPointerCapture(e.pointerId);
            dragStartX = e.clientX;
            dragStartY = e.clientY;
            origLeft = dragBox.offsetLeft;
            origTop = dragBox.offsetTop;
        });

        dragBox.addEventListener('pointermove', (e) => {
            if (!isDragging) return;
            e.preventDefault();
            const dx = e.clientX - dragStartX;
            const dy = e.clientY - dragStartY;

            const maxLeft = Math.max(0, viewport.clientWidth - dragBox.offsetWidth);
            const maxTop = Math.max(0, viewport.clientHeight - dragBox.offsetHeight);

            const newLeft = Math.max(0, Math.min(maxLeft, origLeft + dx));
            const newTop = Math.max(0, Math.min(maxTop, origTop + dy));

            dragBox.style.left = `${newLeft}px`;
            dragBox.style.top = `${newTop}px`;
        });

        const stopDrag = (e) => {
            if (!isDragging) return;
            isDragging = false;
            try { dragBox.releasePointerCapture(e.pointerId); } catch (_) {}
        };

        dragBox.addEventListener('pointerup', stopDrag);
        dragBox.addEventListener('pointercancel', stopDrag);

        // Load PDF & Render Pages
        async function renderPage(pageNum) {
            if (!pdfDoc) return;
            const page = await pdfDoc.getPage(pageNum);
            const initialVp = page.getViewport({ scale: 1.0 });
            const scale = Math.min(650 / initialVp.width, 1.5);
            const scaledVp = page.getViewport({ scale });

            const pdfCanvas = $('#pdf-sign-canvas');
            const pdfCtx = pdfCanvas.getContext('2d');
            pdfCanvas.width = scaledVp.width;
            pdfCanvas.height = scaledVp.height;

            await page.render({
                canvasContext: pdfCtx,
                viewport: scaledVp,
            }).promise;

            $('#pdf-sig-cur-page').textContent = pageNum;
            $('#pdf-sig-total-pages').textContent = totalPdfPages;
            $('#btn-pdf-sig-prev').disabled = pageNum <= 1;
            $('#btn-pdf-sig-next').disabled = pageNum >= totalPdfPages;
        }

        try {
            const pdfjsLib = await ensurePdfJs();
            const resp = await fetch(`api.php?action=download&id=${file.id}`);
            if (!resp.ok) throw new Error(`Download fehlgeschlagen (${resp.status})`);
            pdfArrayBuffer = await resp.arrayBuffer();

            const loadingTask = pdfjsLib.getDocument({ data: pdfArrayBuffer.slice(0) });
            pdfDoc = await loadingTask.promise;
            totalPdfPages = pdfDoc.numPages;
            currentPdfPage = 1;
            await renderPage(1);
        } catch (err) {
            toast(`Fehler beim Laden des PDF-Dokuments: ${err.message}`, 'error');
            closeModal();
            return;
        }

        $('#btn-pdf-sig-prev')?.addEventListener('click', async () => {
            if (currentPdfPage > 1) {
                currentPdfPage--;
                await renderPage(currentPdfPage);
            }
        });

        $('#btn-pdf-sig-next')?.addEventListener('click', async () => {
            if (currentPdfPage < totalPdfPages) {
                currentPdfPage++;
                await renderPage(currentPdfPage);
            }
        });

        $('#btn-pdf-sig-cancel')?.addEventListener('click', () => closeModal());

        // Save Signed PDF using PDF-lib
        $('#btn-pdf-sig-save')?.addEventListener('click', async () => {
            const dataUrl = generateSignatureDataUrl();
            if (!dataUrl || !pdfArrayBuffer) return;

            const btnSave = $('#btn-pdf-sig-save');
            btnSave.disabled = true;
            btnSave.textContent = 'Signiere Dokument…';

            try {
                const PDFLib = await ensurePdfLib();
                const pdfDocLib = await PDFLib.PDFDocument.load(pdfArrayBuffer);

                const pages = pdfDocLib.getPages();
                const targetPage = pages[currentPdfPage - 1];
                const { width: pWidth, height: pHeight } = targetPage.getSize();

                const pdfCanvas = $('#pdf-sign-canvas');
                const cWidth = pdfCanvas.clientWidth || pdfCanvas.width;
                const cHeight = pdfCanvas.clientHeight || pdfCanvas.height;

                const normX = dragBox.offsetLeft / cWidth;
                const normY = dragBox.offsetTop / cHeight;
                const normW = dragBox.offsetWidth / cWidth;
                const normH = dragBox.offsetHeight / cHeight;

                const sigPdfX = normX * pWidth;
                const sigPdfW = normW * pWidth;
                const sigPdfH = normH * pHeight;
                // PDF coordinate system origin is at the bottom-left!
                const sigPdfY = pHeight - (normY * pHeight) - sigPdfH;

                const pngImage = await pdfDocLib.embedPng(dataUrl);
                targetPage.drawImage(pngImage, {
                    x: sigPdfX,
                    y: sigPdfY,
                    width: sigPdfW,
                    height: sigPdfH,
                });

                const savedBytes = await pdfDocLib.save();
                const dotIdx = file.name.lastIndexOf('.');
                const baseName = dotIdx !== -1 ? file.name.slice(0, dotIdx) : file.name;
                const signedFileName = `${baseName}_signiert.pdf`;

                const signedFile = new File([savedBytes], signedFileName, { type: 'application/pdf' });
                closeModal();
                await uploadFileEntries([{ file: signedFile, relativePath: '' }], state.currentFolderId);
                toast(`Signiertes Dokument „${signedFileName}“ erfolgreich gespeichert.`);
            } catch (err) {
                toast(`Fehler beim Signieren: ${err.message}`, 'error');
                btnSave.disabled = false;
                btnSave.textContent = '✍️ Signierte PDF speichern';
            }
        });
    }

    // ZIP Inspector & Extractor Modal
    async function openZipModal(file) {
        try {
            const res = await apiGet({ action: 'zip_inspect', id: file.id });
            const rows = (res.entries || []).slice(0, 200).map((e) => `
                <tr>
                    <td>${e.is_dir ? '📁' : '📄'} ${esc(e.name)}</td>
                    <td class="muted" style="text-align:right">${e.is_dir ? '—' : formatBytes(e.size)}</td>
                </tr>
            `).join('');

            openModal(`ZIP-Archiv: ${file.name}`, `
                <p class="muted small" style="margin-top:0">
                    ${res.total_entries} Einträge · Entpackte Gesamtgröße: <strong>${formatBytes(res.total_uncompressed)}</strong>
                </p>
                <div class="file-table-wrap" style="max-height:320px;overflow-y:auto;margin-bottom:1rem">
                    <table class="file-table">
                        <thead><tr><th>Pfad im Archiv</th><th style="text-align:right">Größe</th></tr></thead>
                        <tbody>${rows || '<tr><td colspan="2" class="empty-cell">Archiv ist leer.</td></tr>'}</tbody>
                    </table>
                </div>
                <div style="display:flex;justify-content:space-between;gap:0.5rem">
                    <a class="btn btn-ghost" href="api.php?action=download&id=${file.id}">⬇️ ZIP herunterladen</a>
                    <button type="button" class="btn btn-primary" id="btn-confirm-unzip">📂 Jetzt im aktuellen Ordner entpacken</button>
                </div>
            `, true);

            $('#btn-confirm-unzip')?.addEventListener('click', async (e) => {
                e.target.disabled = true;
                e.target.textContent = 'Entpacke…';
                try {
                    const ext = await apiPost('zip_extract', { file_id: file.id, target_folder_id: state.currentFolderId });
                    closeModal();
                    toast(`${ext.extracted_files} Datei(en) erfolgreich entpackt.`);
                    loadCurrentView();
                } catch (err) {
                    toast(err.message, 'error');
                    e.target.disabled = false;
                    e.target.textContent = '📂 Jetzt im aktuellen Ordner entpacken';
                }
            });
        } catch (err) {
            toast(err.message, 'error');
        }
    }

    // AES-256-GCM Zero-Knowledge Vault Modal (for single File or entire Folder)
    function openVaultModal(item) {
        if (item.type === 'folder') {
            const defaultDec = (item.encrypted_count || 0) > 0;
            openModal(`🔒 Ordner-Tresor (AES-256): ${item.name}`, `
                <div class="tabs">
                    <button type="button" class="tab-btn ${!defaultDec ? 'active' : ''}" data-fv-tab="fv-enc">🔒 Ordner verschlüsseln</button>
                    <button type="button" class="tab-btn ${defaultDec ? 'active' : ''}" data-fv-tab="fv-dec">🔓 Ordner entschlüsseln</button>
                </div>

                <div id="fv-enc" class="${!defaultDec ? '' : 'hidden'}">
                    <p class="muted small">
                        Alle noch unverschlüsselten Dateien in <strong>${esc(item.name)}</strong> (inkl. aller Unterordner) werden mit <strong>AES-256-GCM</strong> verschlüsselt. Das Passwort wird niemals gespeichert.
                    </p>
                    <form id="folder-vault-enc-form">
                        <div class="form-group">
                            <label>Tresor-Passwort festlegen (mind. 4 Zeichen)</label>
                            <input type="password" name="password" class="input" placeholder="Tresor-Passwort…" required minlength="4">
                        </div>
                        <div class="form-group">
                            <label>Passwort wiederholen</label>
                            <input type="password" name="password2" class="input" placeholder="Passwort bestätigen…" required minlength="4">
                        </div>
                        <button type="submit" class="btn btn-primary btn-block">🔒 Alle Dateien im Ordner verschlüsseln</button>
                    </form>
                </div>

                <div id="fv-dec" class="${defaultDec ? '' : 'hidden'}">
                    <p class="muted small">
                        Entschlüsselt alle verschlüsselten Dateien in <strong>${esc(item.name)}</strong> (inkl. Unterordner), die mit diesem Tresor-Passwort geschützt wurden.
                    </p>
                    <form id="folder-vault-dec-form">
                        <div class="form-group">
                            <label>Tresor-Passwort eingeben</label>
                            <input type="password" name="password" class="input" placeholder="Tresor-Passwort…" required>
                        </div>
                        <button type="submit" class="btn btn-primary btn-block">🔓 Alle Dateien im Ordner entschlüsseln</button>
                    </form>
                </div>
            `);

            const body = $('#modal-body');
            $$('[data-fv-tab]', body).forEach((btn) => {
                btn.addEventListener('click', () => {
                    $$('[data-fv-tab]', body).forEach((b) => b.classList.remove('active'));
                    btn.classList.add('active');
                    $('#fv-enc', body).classList.toggle('hidden', btn.dataset.fvTab !== 'fv-enc');
                    $('#fv-dec', body).classList.toggle('hidden', btn.dataset.fvTab !== 'fv-dec');
                });
            });

            $('#folder-vault-enc-form', body)?.addEventListener('submit', async (e) => {
                e.preventDefault();
                const pw1 = e.target.password.value;
                const pw2 = e.target.password2.value;
                if (pw1 !== pw2) {
                    toast('Die Passwörter stimmen nicht überein.', 'error');
                    return;
                }
                const btn = e.target.querySelector('button[type="submit"]');
                btn.disabled = true;
                btn.textContent = 'Verschlüssele Ordner…';
                try {
                    const res = await apiPost('vault_encrypt_folder', { folder_id: item.id, password: pw1 });
                    closeModal();
                    toast(`${res.encrypted_count} Datei(en) im Ordner verschlüsselt.`);
                    loadCurrentView();
                } catch (err) {
                    toast(err.message, 'error');
                    btn.disabled = false;
                    btn.textContent = '🔒 Alle Dateien im Ordner verschlüsseln';
                }
            });

            $('#folder-vault-dec-form', body)?.addEventListener('submit', async (e) => {
                e.preventDefault();
                const pw = e.target.password.value;
                const btn = e.target.querySelector('button[type="submit"]');
                btn.disabled = true;
                btn.textContent = 'Entschlüssele Ordner…';
                try {
                    const res = await apiPost('vault_decrypt_folder', { folder_id: item.id, password: pw });
                    closeModal();
                    toast(`${res.decrypted_count} Datei(en) im Ordner entschlüsselt.`);
                    loadCurrentView();
                } catch (err) {
                    toast(err.message, 'error');
                    btn.disabled = false;
                    btn.textContent = '🔓 Alle Dateien im Ordner entschlüsseln';
                }
            });
            return;
        }

        const file = item;
        if (!file.is_encrypted) {
            openModal(`🔒 Datei verschlüsseln: ${file.name}`, `
                <p class="muted small">
                    Die Datei wird auf dem Server mit <strong>AES-256-GCM</strong> (PBKDF2-HMAC-SHA256, 100.000 Iterationen) verschlüsselt.
                    Das Passwort wird <strong>niemals</strong> gespeichert (Zero-Knowledge).
                </p>
                <form id="vault-encrypt-form">
                    <div class="form-group">
                        <label>Tresor-Passwort festlegen (mind. 4 Zeichen)</label>
                        <input type="password" name="password" class="input" placeholder="Tresor-Passwort…" required minlength="4">
                    </div>
                    <div class="form-group">
                        <label>Passwort wiederholen</label>
                        <input type="password" name="password2" class="input" placeholder="Passwort bestätigen…" required minlength="4">
                    </div>
                    <button type="submit" class="btn btn-primary btn-block">🔒 Jetzt mit AES-256 verschlüsseln</button>
                </form>
            `);
            $('#vault-encrypt-form').querySelector('input').focus();
            $('#vault-encrypt-form').addEventListener('submit', async (e) => {
                e.preventDefault();
                const pw1 = e.target.password.value;
                const pw2 = e.target.password2.value;
                if (pw1 !== pw2) {
                    toast('Die Passwörter stimmen nicht überein.', 'error');
                    return;
                }
                try {
                    await apiPost('vault_encrypt', { file_id: file.id, password: pw1 });
                    closeModal();
                    toast(`"${file.name}" wurde im Tresor verschlüsselt.`);
                    loadCurrentView();
                } catch (err) {
                    toast(err.message, 'error');
                }
            });
        } else {
            openModal(`🔓 Verschlüsselte Tresor-Datei: ${file.name}`, `
                <p class="muted small">
                    Diese Datei ist mit <strong>AES-256-GCM</strong> geschützt. Geben Sie das Tresor-Passwort ein, um sie einmalig entschlüsselt herunterzuladen oder dauerhaft im Cloud-Speicher zu entschlüsseln.
                </p>
                <form id="vault-decrypt-form" method="post" action="api.php?action=download&id=${file.id}" target="_blank">
                    <input type="hidden" name="csrf_token" value="${esc(state.csrfToken)}">
                    <div class="form-group">
                        <label>Tresor-Passwort</label>
                        <input type="password" name="vault_password" id="vault-pw-inp" class="input" placeholder="Tresor-Passwort eingeben…" required>
                    </div>
                    <div style="display:flex;gap:0.5rem;flex-wrap:wrap">
                        <button type="submit" class="btn btn-primary" style="flex:1">⬇️ Einmalig entschlüsselt herunterladen</button>
                        <button type="button" class="btn btn-ghost" id="btn-vault-unlock-perm" style="flex:1">🔓 Dauerhaft entschlüsseln</button>
                    </div>
                </form>
            `);
            $('#vault-pw-inp').focus();
            $('#btn-vault-unlock-perm').addEventListener('click', async () => {
                const pw = $('#vault-pw-inp').value;
                if (!pw) {
                    toast('Bitte Tresor-Passwort eingeben.', 'error');
                    return;
                }
                try {
                    await apiPost('vault_decrypt', { file_id: file.id, password: pw });
                    closeModal();
                    toast(`"${file.name}" wurde dauerhaft entschlüsselt.`);
                    loadCurrentView();
                } catch (err) {
                    toast(err.message, 'error');
                }
            });
        }
    }

    // Share Modal (Public Links + Internal User Sharing)
    async function openShareModal(item) {
        try {
            const data = await apiGet({ action: 'item_shares', item_type: item.type, item_id: item.id });
            renderShareModalContent(item, data);
        } catch (err) {
            toast(err.message, 'error');
        }
    }

    function renderShareModalContent(item, data) {
        const isFolder = item.type === 'folder';
        const pubRows = (data.public_shares || []).map((ps) => {
            const shareUrl = `${state.baseUrl}/share.php?t=${ps.token}`;
            const modeBadge = ps.mode === 'upload' ? '📤 Nur Upload (File-Drop)' : ps.mode === 'readwrite' ? '🔄 Lesen & Upload' : '⬇️ Download';
            return `
                <div style="border:1px solid var(--border);border-radius:8px;padding:0.65rem;margin-bottom:0.5rem;background:var(--bg)">
                    <div style="display:flex;justify-content:space-between;align-items:center;gap:0.5rem;margin-bottom:0.4rem">
                        <span class="small">
                            <strong>${modeBadge}</strong>
                            ${ps.has_password ? ' · 🔒 Passwort' : ''}
                            ${ps.expires_at ? ` · 📅 bis ${esc(ps.expires_at)}` : ''}
                            · ${ps.download_count}${ps.max_downloads ? '/' + ps.max_downloads : ''} Abrufe
                        </span>
                        <button type="button" class="btn btn-danger btn-sm" data-del-pub="${ps.id}">Löschen</button>
                    </div>
                    <div class="form-row">
                        <input type="text" class="input small" value="${esc(shareUrl)}" readonly onclick="this.select()">
                        <button type="button" class="btn btn-primary btn-sm" data-copy="${esc(shareUrl)}">Kopieren</button>
                        <button type="button" class="btn btn-ghost btn-sm" data-qr="${esc(shareUrl)}">📱 QR-Code</button>
                    </div>
                </div>
            `;
        }).join('');

        const groupRows = (data.group_shares || []).map((gs) => `
            <tr>
                <td>👪 <strong>${esc(gs.group_name)}</strong> <span class="muted small">(${gs.member_count} Mitgl.)</span></td>
                <td>${gs.permission === 'write' ? '✏️ Lesen & Schreiben' : '👁️ Nur Lesen'}</td>
                <td style="text-align:right">
                    <button type="button" class="btn btn-danger btn-sm" data-del-grp="${gs.id}">Entfernen</button>
                </td>
            </tr>
        `).join('');

        const userRows = (data.user_shares || []).map((us) => `
            <tr>
                <td>👤 <strong>${esc(us.display_name)}</strong> <span class="muted small">(@${esc(us.username)})</span></td>
                <td>${us.permission === 'write' ? '✏️ Lesen & Schreiben' : '👁️ Nur Lesen'}</td>
                <td style="text-align:right">
                    <button type="button" class="btn btn-danger btn-sm" data-del-usr="${us.id}">Entfernen</button>
                </td>
            </tr>
        `).join('');

        const groupOpts = (data.available_groups || []).map((g) => `
            <option value="${g.id}">👪 ${esc(g.name)} (${g.member_count} Mitglieder)</option>
        `).join('');

        const userOpts = (data.available_users || []).map((u) => `
            <option value="${u.id}">👤 ${esc(u.display_name)} (@${esc(u.username)})</option>
        `).join('');

        openModal(`🔗 Teilen: ${item.name}`, `
            <div class="tabs">
                <button type="button" class="tab-btn active" data-tab="tab-public">🌐 Öffentlicher Link</button>
                ${!data.is_group_tree ? `<button type="button" class="tab-btn" data-tab="tab-internal">👥 Benutzer & Gruppen</button>` : ''}
            </div>

            <div id="tab-public">
                ${pubRows || '<p class="muted small">Noch kein öffentlicher Link für dieses Element erstellt.</p>'}
                <hr style="border:none;border-top:1px solid var(--border);margin:1rem 0">
                <form id="create-pub-share-form">
                    <h4 style="margin:0 0 0.75rem">Neuen öffentlichen Link erstellen</h4>
                    ${isFolder ? `
                    <div class="form-group">
                        <label>Ordner-Modus</label>
                        <select name="mode" class="input">
                            <option value="download">⬇️ Nur Download (Gäste können Dateien ansehen & herunterladen)</option>
                            <option value="upload">📤 Digitaler Briefkasten / File-Drop (Gäste können nur Dateien hochladen)</option>
                            <option value="readwrite">🔄 Lesen & Hochladen (Gäste können herunterladen und hochladen)</option>
                        </select>
                    </div>` : ''}
                    <div class="form-row" style="margin-bottom:0.75rem">
                        <div style="flex:1">
                            <label class="small muted">Optionales Passwort</label>
                            <input type="password" name="password" class="input" placeholder="Kein Passwort">
                        </div>
                        <div style="flex:1">
                            <label class="small muted">Gültig bis (optional)</label>
                            <input type="date" name="expires_at" class="input">
                        </div>
                        <div style="width:120px">
                            <label class="small muted">Max. Downloads</label>
                            <input type="number" name="max_downloads" class="input" min="1" placeholder="∞">
                        </div>
                    </div>
                    <button type="submit" class="btn btn-primary btn-block">🔗 Link generieren</button>
                </form>
            </div>

            <div id="tab-internal" class="hidden">
                ${groupOpts ? `
                <form id="create-grp-share-form" style="margin-bottom:0.75rem">
                    <label class="small muted" style="display:block;margin-bottom:0.25rem">Für Benutzergruppe freigeben (erscheint bei Mitgliedern unter 👥 Geteilt)</label>
                    <div class="form-row">
                        <select name="target_group_id" class="input" style="flex:2" required>${groupOpts}</select>
                        <select name="permission" class="input" style="flex:1">
                            <option value="write">✏️ Lesen & Schreiben</option>
                            <option value="read">👁️ Nur Lesen</option>
                        </select>
                        <button type="submit" class="btn btn-primary">Gruppe freigeben</button>
                    </div>
                </form>` : ''}

                ${userOpts ? `
                <form id="create-usr-share-form" style="margin-bottom:1rem">
                    <label class="small muted" style="display:block;margin-bottom:0.25rem">Für einzelnen Benutzer freigeben</label>
                    <div class="form-row">
                        <select name="target_user_id" class="input" style="flex:2" required>${userOpts}</select>
                        <select name="permission" class="input" style="flex:1">
                            <option value="read">👁️ Nur Lesen</option>
                            <option value="write">✏️ Lesen & Schreiben</option>
                        </select>
                        <button type="submit" class="btn btn-primary">Freigeben</button>
                    </div>
                </form>` : (!groupOpts ? '<p class="muted small">Keine weiteren Benutzer oder Gruppen vorhanden. Als Admin können Sie unter ⚙️ Admin Benutzer & Gruppen anlegen.</p>' : '')}

                <div class="file-table-wrap">
                    <table class="file-table">
                        <thead><tr><th>Empfänger (Gruppe / Benutzer)</th><th>Berechtigung</th><th style="text-align:right">Aktion</th></tr></thead>
                        <tbody>${(groupRows + userRows) || '<tr><td colspan="3" class="empty-cell">Nicht intern geteilt.</td></tr>'}</tbody>
                    </table>
                </div>
            </div>
        `);

        // Modal Tab Switching
        const body = $('#modal-body');
        $$('.tab-btn', body).forEach((btn) => {
            btn.addEventListener('click', () => {
                $$('.tab-btn', body).forEach((b) => b.classList.remove('active'));
                btn.classList.add('active');
                $('#tab-public', body).classList.toggle('hidden', btn.dataset.tab !== 'tab-public');
                $('#tab-internal', body).classList.toggle('hidden', btn.dataset.tab !== 'tab-internal');
            });
        });

        $$('[data-copy]', body).forEach((btn) => {
            btn.addEventListener('click', () => {
                navigator.clipboard?.writeText(btn.dataset.copy);
                toast('Link in die Zwischenablage kopiert!');
            });
        });

        $$('[data-qr]', body).forEach((btn) => {
            btn.addEventListener('click', () => {
                showQrModal(btn.dataset.qr);
            });
        });

        $$('[data-del-pub]', body).forEach((btn) => {
            btn.addEventListener('click', async () => {
                await apiPost('delete_public_share', { share_id: Number(btn.dataset.delPub) });
                toast('Link gelöscht.');
                openShareModal(item);
                loadCurrentView();
            });
        });

        $$('[data-del-usr]', body).forEach((btn) => {
            btn.addEventListener('click', async () => {
                await apiPost('delete_user_share', { share_id: Number(btn.dataset.delUsr) });
                toast('Freigabe entfernt.');
                openShareModal(item);
                loadCurrentView();
            });
        });

        $$('[data-del-grp]', body).forEach((btn) => {
            btn.addEventListener('click', async () => {
                await apiPost('delete_group_share', { share_id: Number(btn.dataset.delGrp) });
                toast('Gruppen-Freigabe entfernt.');
                openShareModal(item);
                loadCurrentView();
            });
        });

        $('#create-grp-share-form', body)?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const fd = new FormData(e.target);
            try {
                await apiPost('set_group_share', {
                    item_type: item.type,
                    item_id: item.id,
                    target_group_id: Number(fd.get('target_group_id')),
                    permission: fd.get('permission'),
                });
                toast('Für Gruppe freigegeben.');
                openShareModal(item);
                loadCurrentView();
            } catch (err) {
                toast(err.message, 'error');
            }
        });

        $('#create-pub-share-form', body)?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const fd = new FormData(e.target);
            try {
                await apiPost('create_public_share', {
                    item_type: item.type,
                    item_id: item.id,
                    mode: fd.get('mode') || 'download',
                    password: fd.get('password') || '',
                    expires_at: fd.get('expires_at') || '',
                    max_downloads: fd.get('max_downloads') || '',
                });
                toast('Öffentlicher Link erstellt!');
                openShareModal(item);
                loadCurrentView();
            } catch (err) {
                toast(err.message, 'error');
            }
        });

        $('#create-usr-share-form', body)?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const fd = new FormData(e.target);
            try {
                await apiPost('set_user_share', {
                    item_type: item.type,
                    item_id: item.id,
                    target_user_id: Number(fd.get('target_user_id')),
                    permission: fd.get('permission'),
                });
                toast('Für Benutzer freigegeben.');
                openShareModal(item);
                loadCurrentView();
            } catch (err) {
                toast(err.message, 'error');
            }
        });
    }

    // "Meine Freigaben" View
    async function loadMySharesView() {
        $('#folder-write-actions').classList.add('hidden');
        $('#trash-toolbar').classList.add('hidden');
        $('#breadcrumbs').innerHTML = `<span class="crumb active">Meine aktiven Freigaben</span>`;

        try {
            const res = await apiGet({ action: 'my_shares' });
            const pub = res.public_shares || [];
            const usr = res.user_shares || [];
            const grp = res.group_shares || [];
            const container = $('#items-container');

            const pubRows = pub.map((ps) => {
                const url = `${state.baseUrl}/share.php?t=${ps.token}`;
                return `
                    <tr>
                        <td>${ps.item_type === 'folder' ? '📁' : '📄'} <strong>${esc(ps.item_name)}</strong></td>
                        <td>${ps.mode === 'upload' ? '📤 File-Drop' : ps.mode === 'readwrite' ? '🔄 Lesen & Upload' : '⬇️ Download'}${ps.has_password ? ' · 🔒' : ''}</td>
                        <td class="muted small">${ps.expires_at ? esc(ps.expires_at) : 'Unbegrenzt'} (${ps.download_count} Abrufe)</td>
                        <td style="text-align:right;white-space:nowrap">
                            <button type="button" class="btn btn-ghost btn-sm" data-copy-link="${esc(url)}">📋 Link</button>
                            <button type="button" class="btn btn-ghost btn-sm" data-qr-link="${esc(url)}">📱 QR</button>
                            <button type="button" class="btn btn-danger btn-sm" data-revoke-pub="${ps.id}">Löschen</button>
                        </td>
                    </tr>
                `;
            }).join('');

            const grpRows = grp.map((g) => `
                <tr>
                    <td>${g.item_type === 'folder' ? '📁' : '📄'} <strong>${esc(g.item_name)}</strong></td>
                    <td>👪 <strong>${esc(g.group_name)}</strong> <span class="muted small">(${g.member_count} Mitgl.)</span></td>
                    <td>${g.permission === 'write' ? '✏️ Lesen & Schreiben' : '👁️ Nur Lesen'}</td>
                    <td style="text-align:right">
                        <button type="button" class="btn btn-danger btn-sm" data-revoke-grp="${g.id}">Entfernen</button>
                    </td>
                </tr>
            `).join('');

            const usrRows = usr.map((u) => `
                <tr>
                    <td>${u.item_type === 'folder' ? '📁' : '📄'} <strong>${esc(u.item_name)}</strong></td>
                    <td>👤 ${esc(u.display_name)} (@${esc(u.username)})</td>
                    <td>${u.permission === 'write' ? '✏️ Lesen & Schreiben' : '👁️ Nur Lesen'}</td>
                    <td style="text-align:right">
                        <button type="button" class="btn btn-danger btn-sm" data-revoke-usr="${u.id}">Entfernen</button>
                    </td>
                </tr>
            `).join('');

            container.innerHTML = `
                <h3 style="margin-top:0">🌐 Öffentliche Links (${pub.length})</h3>
                <div class="file-table-wrap" style="margin-bottom:1.75rem">
                    <table class="file-table">
                        <thead><tr><th>Element</th><th>Modus</th><th>Gültigkeit</th><th style="text-align:right">Aktion</th></tr></thead>
                        <tbody>${pubRows || '<tr><td colspan="4" class="empty-cell">Keine öffentlichen Links aktiv.</td></tr>'}</tbody>
                    </table>
                </div>

                <h3>👥 Interne Benutzer- & Gruppen-Freigaben (${usr.length + grp.length})</h3>
                <div class="file-table-wrap">
                    <table class="file-table">
                        <thead><tr><th>Element</th><th>Freigegeben für</th><th>Berechtigung</th><th style="text-align:right">Aktion</th></tr></thead>
                        <tbody>${(grpRows + usrRows) || '<tr><td colspan="4" class="empty-cell">Keine internen Freigaben aktiv.</td></tr>'}</tbody>
                    </table>
                </div>
            `;

            $$('[data-copy-link]', container).forEach((btn) => {
                btn.addEventListener('click', () => {
                    navigator.clipboard?.writeText(btn.dataset.copyLink);
                    toast('Link kopiert!');
                });
            });
            $$('[data-qr-link]', container).forEach((btn) => {
                btn.addEventListener('click', () => {
                    showQrModal(btn.dataset.qrLink);
                });
            });
            $$('[data-revoke-pub]', container).forEach((btn) => {
                btn.addEventListener('click', async () => {
                    await apiPost('delete_public_share', { share_id: Number(btn.dataset.revokePub) });
                    toast('Link gelöscht.');
                    loadMySharesView();
                });
            });
            $$('[data-revoke-grp]', container).forEach((btn) => {
                btn.addEventListener('click', async () => {
                    await apiPost('delete_group_share', { share_id: Number(btn.dataset.revokeGrp) });
                    toast('Gruppen-Freigabe beendet.');
                    loadMySharesView();
                });
            });
            $$('[data-revoke-usr]', container).forEach((btn) => {
                btn.addEventListener('click', async () => {
                    await apiPost('delete_user_share', { share_id: Number(btn.dataset.revokeUsr) });
                    toast('Freigabe beendet.');
                    loadMySharesView();
                });
            });
            pushNavigationState();
        } catch (err) {
            toast(err.message, 'error');
        }
    }

    // "➕ Neu" Dropdown Menu & Upload Triggers
    $('#btn-new-menu-toggle')?.addEventListener('click', (e) => {
        e.stopPropagation();
        $('#undo-history-menu')?.classList.add('hidden');
        $('#new-action-menu')?.classList.toggle('hidden');
    });

    document.addEventListener('click', () => {
        $('#new-action-menu')?.classList.add('hidden');
        $('#undo-history-menu')?.classList.add('hidden');
        state.filterMenuOpen = false;
        $('#th-filter-menu')?.classList.add('hidden');
    });

    $('#btn-upload-trigger')?.addEventListener('click', () => {
        setMobileSidebarOpen(false);
        $('#file-input-multi').click();
    });
    $('#menu-upload-files')?.addEventListener('click', () => $('#file-input-multi').click());
    $('#menu-upload-folder')?.addEventListener('click', () => $('#folder-input-multi').click());
    $('#btn-upload-folder')?.addEventListener('click', () => $('#folder-input-multi').click());

    $('#file-input-multi')?.addEventListener('change', async (e) => {
        const files = Array.from(e.target.files || []).map((f) => ({ file: f, relativePath: '' }));
        e.target.value = '';
        await uploadFileEntries(files, state.currentFolderId);
    });

    $('#folder-input-multi')?.addEventListener('change', async (e) => {
        const files = Array.from(e.target.files || []).map((f) => ({
            file: f,
            relativePath: f.webkitRelativePath || '',
        }));
        e.target.value = '';
        await uploadFileEntries(files, state.currentFolderId);
    });

    // Global Window Drag & Drop for External Files/Folders
    let dragDepth = 0;
    function hideDropOverlay() {
        dragDepth = 0;
        $('#drop-overlay')?.classList.add('hidden');
    }

    // Always hide drop overlay in capture phase whenever a drop or dragend happens anywhere
    window.addEventListener('drop', hideDropOverlay, true);
    window.addEventListener('dragend', hideDropOverlay, true);

    window.addEventListener('dragenter', (e) => {
        if (!state.user || e.dataTransfer?.types?.includes('application/x-cloud-item')) return;
        if (e.dataTransfer?.types?.includes('Files')) {
            dragDepth++;
            $('#drop-overlay').classList.remove('hidden');
        }
    });
    window.addEventListener('dragleave', (e) => {
        if (e.dataTransfer?.types?.includes('Files')) {
            dragDepth = Math.max(0, dragDepth - 1);
            if (
                dragDepth === 0 ||
                !e.relatedTarget ||
                e.clientX <= 0 ||
                e.clientY <= 0 ||
                e.clientX >= window.innerWidth ||
                e.clientY >= window.innerHeight
            ) {
                hideDropOverlay();
            }
        }
    });
    window.addEventListener('dragover', (e) => {
        if (e.dataTransfer?.types?.includes('Files')) {
            e.preventDefault();
        }
    });
    window.addEventListener('drop', async (e) => {
        hideDropOverlay();
        if (!state.user || e.dataTransfer?.types?.includes('application/x-cloud-item')) return;
        if (e.dataTransfer?.files?.length > 0) {
            e.preventDefault();
            const entries = await extractDroppedFileEntries(e.dataTransfer);
            await uploadFileEntries(entries, state.currentFolderId);
        }
    });

    async function extractDroppedFileEntries(dataTransfer) {
        const results = [];
        const items = dataTransfer.items ? Array.from(dataTransfer.items) : [];
        const webkitEntries = items
            .map((it) => (typeof it.webkitGetAsEntry === 'function' ? it.webkitGetAsEntry() : null))
            .filter(Boolean);

        if (webkitEntries.length > 0) {
            async function traverse(entry, pathPrefix = '') {
                if (entry.isFile) {
                    const file = await new Promise((resolve) => entry.file(resolve));
                    results.push({ file, relativePath: pathPrefix ? `${pathPrefix}/${file.name}` : '' });
                } else if (entry.isDirectory) {
                    const reader = entry.createReader();
                    let batch = [];
                    do {
                        batch = await new Promise((resolve) => reader.readEntries(resolve));
                        for (const child of batch) {
                            await traverse(child, pathPrefix ? `${pathPrefix}/${entry.name}` : entry.name);
                        }
                    } while (batch.length > 0);
                }
            }
            for (const entry of webkitEntries) {
                await traverse(entry, '');
            }
            return results;
        }

        return Array.from(dataTransfer.files || []).map((f) => ({
            file: f,
            relativePath: f.webkitRelativePath || '',
        }));
    }

    function promptUploadConflictResolution(conflicts) {
        return new Promise((resolve) => {
            const count = conflicts.length;
            const title = count === 1 ? '⚠️ Datei existiert bereits' : `⚠️ ${count} Dateien existieren bereits`;
            const listHtml = conflicts.map((c) => `<li style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">📄 ${esc(c)}</li>`).join('');

            openModal(title, `
                <div style="display:flex;flex-direction:column;gap:0.75rem">
                    <p class="muted small" style="margin:0">
                        Im Zielordner sind bereits ${count === 1 ? 'eine Datei' : `${count} Dateien`} mit gleichem Namen vorhanden:
                    </p>
                    <ul style="max-height:130px;overflow-y:auto;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:0.5rem 1rem;margin:0;list-style:none;font-size:0.84rem;display:flex;flex-direction:column;gap:0.25rem">
                        ${listHtml}
                    </ul>
                    <p class="small muted" style="margin:0">
                        Wie möchten Sie mit vorhandenen Dateien verfahren?
                    </p>
                    <div style="display:flex;flex-direction:column;gap:0.5rem;margin-top:0.35rem">
                        <button type="button" class="btn btn-primary" id="btn-conflict-overwrite" style="justify-content:flex-start">
                            🔄 <strong>Überschreiben</strong>
                            <span class="muted small" style="margin-left:auto;color:rgba(255,255,255,0.75)">Sichert bisherige Versionen in der Historie</span>
                        </button>
                        <button type="button" class="btn btn-ghost" id="btn-conflict-keep-both" style="justify-content:flex-start;border:1px solid var(--border)">
                            📋 <strong>Beide behalten</strong>
                            <span class="muted small" style="margin-left:auto">Benennt neu hochgeladene Dateien um</span>
                        </button>
                        <button type="button" class="btn btn-ghost" id="btn-conflict-skip" style="justify-content:flex-start;border:1px solid var(--border)">
                            ⏭️ <strong>Überspringen</strong>
                            <span class="muted small" style="margin-left:auto">Lädt nur neue Dateien hoch</span>
                        </button>
                    </div>
                    <div style="display:flex;justify-content:flex-end;margin-top:0.4rem">
                        <button type="button" class="btn btn-ghost btn-sm" id="btn-conflict-cancel">Upload abbrechen</button>
                    </div>
                </div>
            `);

            $('#btn-conflict-overwrite')?.addEventListener('click', () => { closeModal(); resolve('overwrite'); });
            $('#btn-conflict-keep-both')?.addEventListener('click', () => { closeModal(); resolve('keep_both'); });
            $('#btn-conflict-skip')?.addEventListener('click', () => { closeModal(); resolve('skip'); });
            $('#btn-conflict-cancel')?.addEventListener('click', () => { closeModal(); resolve('cancel'); });
            $('#modal-close-btn')?.addEventListener('click', () => { resolve('cancel'); });
        });
    }

    function renameConflictingFile(originalFile, existingNames) {
        const full = originalFile.name;
        const lastDot = full.lastIndexOf('.');
        const base = lastDot > 0 ? full.slice(0, lastDot) : full;
        const ext = lastDot > 0 ? full.slice(lastDot) : '';

        let index = 1;
        let newName = `${base} (${index})${ext}`;
        while (existingNames.includes(newName)) {
            index++;
            newName = `${base} (${index})${ext}`;
        }
        existingNames.push(newName);

        try {
            return new File([originalFile], newName, { type: originalFile.type });
        } catch (_) {
            return {
                ...originalFile,
                name: newName,
                slice: (...args) => originalFile.slice(...args),
                size: originalFile.size,
                type: originalFile.type,
            };
        }
    }

    async function uploadFileEntries(entries, targetFolderId) {
        hideDropOverlay();
        if (!entries || entries.length === 0) return;

        // Check for upload conflicts on root-level files in target folder
        const flatNames = entries
            .filter((e) => !e.relativePath || !e.relativePath.includes('/'))
            .map((e) => e.file.name);

        if (flatNames.length > 0) {
            try {
                const confRes = await apiPost('check_upload_conflicts', {
                    folder_id: targetFolderId,
                    file_names: flatNames,
                    _skip_undo: true,
                });
                const conflicts = confRes.conflicts || [];
                if (conflicts.length > 0) {
                    const resolution = await promptUploadConflictResolution(conflicts);
                    if (resolution === 'cancel') {
                        return;
                    } else if (resolution === 'skip') {
                        entries = entries.filter((e) => !conflicts.includes(e.file.name));
                        if (entries.length === 0) {
                            toast('Dateien wurden übersprungen.');
                            return;
                        }
                    } else if (resolution === 'keep_both') {
                        const existingPool = [...conflicts];
                        for (const entry of entries) {
                            if (conflicts.includes(entry.file.name)) {
                                entry.file = renameConflictingFile(entry.file, existingPool);
                            }
                        }
                    }
                    // 'overwrite' proceeds as-is (and backend automatically archives the old version!)
                }
            } catch (err) {
                console.warn('Conflict check failed, proceeding with normal upload:', err);
            }
        }

        const panel = $('#upload-progress-panel');
        const statusLbl = $('#upload-status-label');
        const pctLbl = $('#upload-percent-label');
        const fill = $('#upload-progress-fill');
        pctLbl.textContent = '0%';
        fill.style.width = '0%';
        panel.classList.remove('hidden');

        const totalBytes = entries.reduce((acc, e) => acc + (e.file.size || 0), 0);
        let uploadedBytes = 0;
        let successCount = 0;

        activeUploadCount++;
        try {
            for (let i = 0; i < entries.length; i++) {
                const { file, relativePath } = entries[i];
                const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
                const uploadId = `${Date.now()}_${i}_${Math.random().toString(36).slice(2, 9)}`;

                statusLbl.textContent = `Lade hoch (${i + 1}/${entries.length}): ${file.name}`;

                try {
                    for (let chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
                        const start = chunkIdx * CHUNK_SIZE;
                        const end = Math.min(file.size, start + CHUNK_SIZE);
                        const blob = file.slice(start, end);

                        const fd = new FormData();
                        fd.append('action', 'upload_chunk');
                        fd.append('csrf_token', state.csrfToken);
                        if (targetFolderId !== null) {
                            fd.append('folder_id', String(targetFolderId));
                        }
                        fd.append('upload_id', uploadId);
                        fd.append('chunk_index', String(chunkIdx));
                        fd.append('total_chunks', String(totalChunks));
                        fd.append('file_name', file.name);
                        fd.append('total_size', String(file.size));
                        fd.append('relative_path', relativePath || '');
                        fd.append('chunk', blob, file.name);

                        const res = await fetch('api.php?action=upload_chunk', {
                            method: 'POST',
                            credentials: 'same-origin',
                            headers: { 'X-CSRF-Token': state.csrfToken },
                            body: fd,
                        });
                        const data = await parseJsonResponse(res);
                        if (!res.ok || !data.ok) {
                            throw new Error(data.error || `Fehler bei ${file.name}`);
                        }

                        uploadedBytes += (end - start);
                        const pct = totalBytes > 0 ? Math.min(100, Math.round((uploadedBytes / totalBytes) * 100)) : 100;
                        pctLbl.textContent = `${pct}%`;
                        fill.style.width = `${pct}%`;
                    }
                    successCount++;
                } catch (err) {
                    toast(err.message, 'error');
                }
            }
        } finally {
            activeUploadCount = Math.max(0, activeUploadCount - 1);
            hideDropOverlay();
            panel.classList.add('hidden');
            fill.style.width = '0%';
        }

        if (successCount > 0) {
            toast(`${successCount} Datei(en) erfolgreich hochgeladen.`);
            await loadCurrentView();
        }
    }

    // WebDAV Info Modal
    $('#btn-webdav-info')?.addEventListener('click', () => {
        setMobileSidebarOpen(false);
        openWebdavModal();
    });

    function openWebdavModal(generatedToken = '') {
        const hasToken = !!(state.user?.has_webdav_token || generatedToken);
        const has2fa = !!(state.user?.totp_enabled || state.user?.email_2fa_enabled || state.user?.passkey_2fa_enabled);

        openModal('📡 WebDAV – Als Netzlaufwerk einbinden', `
            <p class="muted small" style="margin-top:0">
                Binden Sie Ihren Cloud-Speicher direkt als Laufwerk im Dateimanager ein – ganz ohne Zusatzsoftware:
            </p>
            <div class="form-group">
                <label>Ihre WebDAV-Serveradresse</label>
                <div class="form-row">
                    <input type="text" class="input" value="${esc(state.webdavUrl)}" readonly onclick="this.select()">
                    <button type="button" class="btn btn-primary" id="btn-copy-webdav">Kopieren</button>
                </div>
            </div>

            <div style="border:1px solid var(--border);border-radius:10px;padding:0.9rem;margin:0.9rem 0;background:var(--bg)">
                <div style="display:flex;justify-content:space-between;align-items:center;gap:0.5rem;flex-wrap:wrap">
                    <div>
                        <strong>🔑 WebDAV-App-Passwort ${has2fa ? '(Bei 2FA erforderlich)' : '(Empfohlen)'}</strong>
                        <div class="muted small">
                            Separates Geräte-Passwort für Netzlaufwerke, damit Ihr Hauptkonto trotz WebDAV durch 2FA geschützt bleibt.
                        </div>
                    </div>
                    <div style="display:flex;gap:0.4rem">
                        <button type="button" class="btn btn-primary btn-sm" id="btn-gen-dav-token">
                            ${hasToken ? '🔄 Neu erzeugen' : '➕ App-Passwort erstellen'}
                        </button>
                        ${hasToken ? `<button type="button" class="btn btn-danger btn-sm" id="btn-rev-dav-token">Widerrufen</button>` : ''}
                    </div>
                </div>
                ${generatedToken ? `
                <div class="alert alert-success" style="margin:0.75rem 0 0">
                    <div class="small">Ihr neues WebDAV-App-Passwort (bitte jetzt kopieren):</div>
                    <div class="form-row" style="margin-top:0.4rem">
                        <input type="text" class="input" value="${esc(generatedToken)}" readonly onclick="this.select()" style="font-family:monospace;font-weight:700">
                        <button type="button" class="btn btn-primary btn-sm" id="btn-copy-dav-token">Kopieren</button>
                    </div>
                </div>` : ''}
            </div>

            <div class="code-box small">
                <strong>Windows Explorer:</strong> Dieser PC → Netzlaufwerk verbinden → Adresse einfügen<br>
                <strong>macOS Finder:</strong> Gehe zu → Mit Server verbinden (⌘K) → Adresse einfügen<br>
                <strong>Linux (GNOME/KDE):</strong> <code>davs://${esc(state.webdavUrl.replace(/^https?:\/\//, ''))}</code><br>
                <strong>Benutzername:</strong> <code>${esc(state.user?.username)}</code> · <strong>Passwort:</strong> ${hasToken ? 'Ihr WebDAV-App-Passwort' : 'Ihr Konto-Passwort'}
            </div>
        `);

        $('#btn-copy-webdav')?.addEventListener('click', () => {
            navigator.clipboard?.writeText(state.webdavUrl);
            toast('WebDAV-Adresse kopiert!');
        });
        $('#btn-copy-dav-token')?.addEventListener('click', () => {
            navigator.clipboard?.writeText(generatedToken);
            toast('WebDAV-App-Passwort kopiert!');
        });
        $('#btn-gen-dav-token')?.addEventListener('click', async () => {
            try {
                const res = await apiPost('generate_webdav_token');
                if (res.user) state.user = res.user;
                openWebdavModal(res.app_password);
                toast('Neues WebDAV-App-Passwort erstellt!');
            } catch (err) {
                toast(err.message, 'error');
            }
        });
        $('#btn-rev-dav-token')?.addEventListener('click', async () => {
            if (!confirm('WebDAV-App-Passwort wirklich widerrufen?')) return;
            try {
                const res = await apiPost('revoke_webdav_token');
                if (res.user) state.user = res.user;
                openWebdavModal('');
                toast('WebDAV-App-Passwort widerrufen.');
            } catch (err) {
                toast(err.message, 'error');
            }
        });
    }

    // PWA Service Worker & Install Prompt Capture
    let deferredPwaPrompt = null;

    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('sw.js').catch(() => {});
        });
    }

    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredPwaPrompt = e;
    });

    window.addEventListener('appinstalled', () => {
        deferredPwaPrompt = null;
        toast('App wurde erfolgreich installiert!');
    });

    function isRunningAsPwa() {
        return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    }

    // User Profile & 2FA Security Modal
    $('#btn-profile-modal')?.addEventListener('click', () => {
        setMobileSidebarOpen(false);
        openProfileModal('tab-profile');
    });

    async function openProfileModal(initialTab = 'tab-profile', generatedDavToken = '') {
        if (!state.user) return;
        try {
            const sec = await apiGet({ action: '2fa_status' });
            const passkeyRows = (sec.passkeys || []).map((pk) => `
                <tr>
                    <td>🔑 <strong>${esc(pk.device_name)}</strong></td>
                    <td class="muted small">${esc((pk.created_at || '').slice(0, 10))}</td>
                    <td style="text-align:right">
                        <button type="button" class="btn btn-danger btn-sm" data-del-pk="${pk.id}">Entfernen</button>
                    </td>
                </tr>
            `).join('');

            const isInstalled = isRunningAsPwa();
            const hasDavToken = !!(state.user?.has_webdav_token || generatedDavToken);
            const has2fa = !!(sec.totp_enabled || sec.email_2fa_enabled || sec.passkey_2fa_enabled);
            const isAdmin = state.user.role === 'admin';

            openModal('👤 Einstellungen', `
                <div class="tabs">
                    <button type="button" class="tab-btn ${initialTab === 'tab-profile' ? 'active' : ''}" data-prof-tab="tab-profile">👤 Profil</button>
                    <button type="button" class="tab-btn ${initialTab === 'tab-2fa' ? 'active' : ''}" data-prof-tab="tab-2fa">🔐 2FA</button>
                    <button type="button" class="tab-btn ${initialTab === 'tab-webdav' ? 'active' : ''}" data-prof-tab="tab-webdav">📡 WebDAV</button>
                    <button type="button" class="tab-btn ${initialTab === 'tab-pwa' ? 'active' : ''}" data-prof-tab="tab-pwa">📱 App</button>
                    ${isAdmin ? `<button type="button" class="tab-btn" id="btn-open-admin-from-profile" title="Administration öffnen" style="margin-left:auto">⚙️</button>` : ''}
                </div>

                <!-- Tab 1: Profile, Theme & Password -->
                <div id="tab-profile" class="${initialTab === 'tab-profile' ? '' : 'hidden'}">
                    <div style="display:flex;justify-content:space-between;align-items:center;padding:0.75rem 0.9rem;border:1px solid var(--border);border-radius:10px;background:var(--bg);margin-bottom:0.9rem">
                        <div>
                            <strong>🌓 Erscheinungsbild (Design)</strong>
                            <div class="muted small">Zwischen dunklem und hellem Farbschema wechseln</div>
                        </div>
                        <button type="button" class="btn btn-ghost btn-sm" id="btn-modal-theme-toggle">
                            ${state.theme === 'dark' ? '☀️ Hell aktivieren' : '🌙 Dunkel aktivieren'}
                        </button>
                    </div>

                    <form id="profile-form">
                        <div class="form-group">
                            <label>Benutzername</label>
                            <input type="text" class="input" value="${esc(state.user.username)}" disabled>
                        </div>
                        <div class="form-row" style="margin-bottom:0.85rem">
                            <div style="flex:1">
                                <label class="small muted">Anzeigename</label>
                                <input type="text" name="display_name" class="input" value="${esc(state.user.display_name)}" required>
                            </div>
                            <div style="flex:1">
                                <label class="small muted">E-Mail-Adresse (für E-Mail-2FA)</label>
                                <input type="email" name="email" class="input" value="${esc(sec.email || '')}" placeholder="name@beispiel.de">
                            </div>
                        </div>
                        <hr style="border:none;border-top:1px solid var(--border);margin:0.9rem 0">
                        <p class="small muted" style="margin-top:0">Passwort ändern (leer lassen, wenn das Passwort gleich bleiben soll):</p>
                        <div class="form-row" style="margin-bottom:0.9rem">
                            <div style="flex:1">
                                <label class="small muted">Aktuelles Passwort</label>
                                <input type="password" name="current_password" class="input" placeholder="Nur bei Passwortänderung">
                            </div>
                            <div style="flex:1">
                                <label class="small muted">Neues Passwort (mind. 6 Zeichen)</label>
                                <input type="password" name="new_password" class="input" minlength="6" placeholder="Unverändert">
                            </div>
                        </div>
                        <button type="submit" class="btn btn-primary btn-block">Profil speichern</button>
                    </form>
                </div>

                <!-- Tab 2: 2FA & Biometrics -->
                <div id="tab-2fa" class="${initialTab === 'tab-2fa' ? '' : 'hidden'}">
                    <!-- 1. TOTP Authenticator App -->
                    <div style="border:1px solid var(--border);border-radius:10px;padding:0.9rem;margin-bottom:0.9rem;background:var(--bg)">
                        <div style="display:flex;justify-content:space-between;align-items:center;gap:0.5rem">
                            <div>
                                <strong>📱 Authenticator-App (TOTP)</strong>
                                <div class="muted small">Google/Microsoft Authenticator, Aegis, Bitwarden, Apple Passwörter</div>
                            </div>
                            ${sec.totp_enabled
                                ? `<button type="button" class="btn btn-danger btn-sm" id="btn-totp-disable">Deaktivieren</button>`
                                : `<button type="button" class="btn btn-primary btn-sm" id="btn-totp-start">Einrichten</button>`
                            }
                        </div>
                        <div id="totp-setup-box" class="hidden" style="margin-top:0.9rem;border-top:1px solid var(--border);padding-top:0.9rem"></div>
                    </div>

                    <!-- 2. Biometrie / Passkeys (WebAuthn) -->
                    <div style="border:1px solid var(--border);border-radius:10px;padding:0.9rem;margin-bottom:0.9rem;background:var(--bg)">
                        <div style="display:flex;justify-content:space-between;align-items:center;gap:0.5rem;margin-bottom:0.65rem">
                            <div>
                                <strong>🔑 Biometrie & Passkeys</strong>
                                <div class="muted small">Fingerabdruck (TouchID / Android), FaceID oder Windows Hello</div>
                            </div>
                            <button type="button" class="btn btn-primary btn-sm" id="btn-add-passkey">➕ Gerät hinzufügen</button>
                        </div>
                        <div class="file-table-wrap" style="margin-bottom:0.65rem">
                            <table class="file-table">
                                <tbody>${passkeyRows || '<tr><td colspan="3" class="empty-cell" style="padding:0.75rem !important">Noch kein Biometrie-Gerät registriert.</td></tr>'}</tbody>
                            </table>
                        </div>
                        <label class="small" style="display:flex;align-items:center;gap:0.45rem;cursor:pointer">
                            <input type="checkbox" id="chk-passkey-2fa" ${sec.passkey_2fa_enabled ? 'checked' : ''} ${(sec.passkeys || []).length === 0 ? 'disabled' : ''}>
                            <span>Beim Login mit Passwort zusätzlich Biometrie / Passkey als 2. Faktor verlangen</span>
                        </label>
                    </div>

                    <!-- 3. E-Mail-Einmalcode (2FA) -->
                    <div style="border:1px solid var(--border);border-radius:10px;padding:0.9rem;background:var(--bg)">
                        <div style="display:flex;align-items:center;justify-content:space-between;gap:0.75rem">
                            <div>
                                <strong>✉️ E-Mail-Einmalcode (2FA)</strong>
                                <div class="muted small">
                                    Sendet beim Login einen 6-stelligen Code an <strong>${esc(sec.email || 'keine E-Mail hinterlegt')}</strong>
                                </div>
                            </div>
                            ${sec.email_2fa_enabled
                                ? `<button type="button" class="btn btn-danger btn-sm" id="btn-email-2fa-disable">Deaktivieren</button>`
                                : `<button type="button" class="btn btn-primary btn-sm" id="btn-email-2fa-start">Testcode senden</button>`
                            }
                        </div>
                        <div id="email-2fa-setup-box" class="hidden" style="margin-top:0.85rem;border-top:1px solid var(--border);padding-top:0.85rem"></div>
                    </div>
                </div>

                <!-- Tab 3: WebDAV -->
                <div id="tab-webdav" class="${initialTab === 'tab-webdav' ? '' : 'hidden'}">
                    <p class="muted small" style="margin-top:0">
                        Binden Sie Ihren Cloud-Speicher direkt als Netzlaufwerk im Dateimanager ein – ganz ohne Zusatzsoftware:
                    </p>
                    <div class="form-group">
                        <label>Ihre WebDAV-Serveradresse</label>
                        <div class="form-row">
                            <input type="text" class="input" value="${esc(state.webdavUrl)}" readonly onclick="this.select()">
                            <button type="button" class="btn btn-primary" id="btn-copy-webdav">Kopieren</button>
                        </div>
                    </div>

                    <div style="border:1px solid var(--border);border-radius:10px;padding:0.9rem;margin:0.9rem 0;background:var(--bg)">
                        <div style="display:flex;justify-content:space-between;align-items:center;gap:0.5rem;flex-wrap:wrap">
                            <div>
                                <strong>🔑 WebDAV-App-Passwort ${has2fa ? '(Bei 2FA erforderlich)' : '(Empfohlen)'}</strong>
                                <div class="muted small">
                                    Separates Geräte-Passwort für Netzlaufwerke, damit Ihr Hauptkonto trotz WebDAV durch 2FA geschützt bleibt.
                                </div>
                            </div>
                            <div style="display:flex;gap:0.4rem">
                                <button type="button" class="btn btn-primary btn-sm" id="btn-gen-dav-token">
                                    ${hasDavToken ? '🔄 Neu erzeugen' : '➕ App-Passwort erstellen'}
                                </button>
                                ${hasDavToken ? `<button type="button" class="btn btn-danger btn-sm" id="btn-rev-dav-token">Widerrufen</button>` : ''}
                            </div>
                        </div>
                        ${generatedDavToken ? `
                        <div class="alert alert-success" style="margin:0.75rem 0 0">
                            <div class="small">Ihr neues WebDAV-App-Passwort (bitte jetzt kopieren):</div>
                            <div class="form-row" style="margin-top:0.4rem">
                                <input type="text" class="input" value="${esc(generatedDavToken)}" readonly onclick="this.select()" style="font-family:monospace;font-weight:700">
                                <button type="button" class="btn btn-primary btn-sm" id="btn-copy-dav-token">Kopieren</button>
                            </div>
                        </div>` : ''}
                    </div>

                    <div class="code-box small">
                        <strong>Windows Explorer:</strong> Dieser PC → Netzlaufwerk verbinden → Adresse einfügen<br>
                        <strong>macOS Finder:</strong> Gehe zu → Mit Server verbinden (⌘K) → Adresse einfügen<br>
                        <strong>Linux (GNOME/KDE):</strong> <code>davs://${esc(state.webdavUrl.replace(/^https?:\/\//, ''))}</code><br>
                        <strong>Benutzername:</strong> <code>${esc(state.user?.username)}</code> · <strong>Passwort:</strong> ${hasDavToken ? 'Ihr WebDAV-App-Passwort' : 'Ihr Konto-Passwort'}
                    </div>
                </div>

                <!-- Tab 4: Progressive Web App (PWA) Installation -->
                <div id="tab-pwa" class="${initialTab === 'tab-pwa' ? '' : 'hidden'}">
                    <div style="border:1px solid var(--border);border-radius:10px;padding:1.1rem;background:var(--bg);text-align:center;margin-bottom:1rem">
                        <img src="manifest.php?icon=192" alt="App Icon" style="width:64px;height:64px;border-radius:14px;margin-bottom:0.5rem">
                        <h4 style="margin:0 0 0.3rem">${esc(state.appName)} als App nutzen</h4>
                        <p class="muted small" style="margin:0 0 1rem">
                            Installieren Sie die Cloud direkt auf Ihrem Startbildschirm oder Desktop – ohne Adressleiste und im Vollbildmodus wie eine native App.
                        </p>
                        ${isInstalled
                            ? `<div class="alert alert-success" style="margin-bottom:0">✅ Sie nutzen ${esc(state.appName)} bereits als installierte App!</div>`
                            : deferredPwaPrompt
                                ? `<button type="button" class="btn btn-primary btn-block" id="btn-install-pwa-now">📲 Jetzt als App installieren</button>`
                                : `<div class="code-box small" style="text-align:left">
                                    <strong>📱 Android (Chrome / Edge / Samsung):</strong><br>
                                    Tippen Sie oben rechts im Browser-Menü (<code>⋮</code>) auf <strong>„App installieren“</strong> bzw. <strong>„Zum Startbildschirm hinzufügen“</strong>.<br><br>
                                    <strong>🍏 iPhone & iPad (Safari):</strong><br>
                                    Tippen Sie unten auf das <strong>Teilen-Symbol</strong> (<code>⬆️</code>) und wählen Sie <strong>„Zum Home-Bildschirm“</strong>.<br><br>
                                    <strong>💻 Windows, macOS & Linux (Chrome / Edge):</strong><br>
                                    Klicken Sie rechts in der Adressleiste auf das <strong>Installieren-Symbol (⊕ / 🖥️)</strong>.
                                   </div>`
                        }
                    </div>
                </div>
            `);

            const body = $('#modal-body');

            // Tab switching
            $$('[data-prof-tab]', body).forEach((btn) => {
                btn.addEventListener('click', () => {
                    $$('[data-prof-tab]', body).forEach((b) => b.classList.remove('active'));
                    btn.classList.add('active');
                    ['tab-profile', 'tab-2fa', 'tab-webdav', 'tab-pwa'].forEach((tId) => {
                        $(`#${tId}`, body)?.classList.toggle('hidden', btn.dataset.profTab !== tId);
                    });
                });
            });

            // Open Admin Modal from Profile Menu
            $('#btn-open-admin-from-profile', body)?.addEventListener('click', () => {
                openAdminModal();
            });

            // Theme Toggle inside Profile Modal
            $('#btn-modal-theme-toggle', body)?.addEventListener('click', (e) => {
                state.theme = state.theme === 'dark' ? 'light' : 'dark';
                document.documentElement.setAttribute('data-theme', state.theme);
                localStorage.setItem('cloud_theme', state.theme);
                e.target.textContent = state.theme === 'dark' ? '☀️ Hell aktivieren' : '🌙 Dunkel aktivieren';
            });

            // WebDAV Controls inside Profile Modal
            $('#btn-copy-webdav', body)?.addEventListener('click', () => {
                navigator.clipboard?.writeText(state.webdavUrl);
                toast('WebDAV-Adresse kopiert!');
            });
            $('#btn-copy-dav-token', body)?.addEventListener('click', () => {
                navigator.clipboard?.writeText(generatedDavToken);
                toast('WebDAV-App-Passwort kopiert!');
            });
            $('#btn-gen-dav-token', body)?.addEventListener('click', async () => {
                try {
                    const res = await apiPost('generate_webdav_token');
                    if (res.user) state.user = res.user;
                    openProfileModal('tab-webdav', res.app_password);
                    toast('Neues WebDAV-App-Passwort erstellt!');
                } catch (err) {
                    toast(err.message, 'error');
                }
            });
            $('#btn-rev-dav-token', body)?.addEventListener('click', async () => {
                if (!confirm('WebDAV-App-Passwort wirklich widerrufen?')) return;
                try {
                    const res = await apiPost('revoke_webdav_token');
                    if (res.user) state.user = res.user;
                    openProfileModal('tab-webdav', '');
                    toast('WebDAV-App-Passwort widerrufen.');
                } catch (err) {
                    toast(err.message, 'error');
                }
            });

            // 1-Click PWA Install Button
            $('#btn-install-pwa-now', body)?.addEventListener('click', async () => {
                if (!deferredPwaPrompt) return;
                deferredPwaPrompt.prompt();
                const choice = await deferredPwaPrompt.userChoice;
                if (choice && choice.outcome === 'accepted') {
                    deferredPwaPrompt = null;
                    openProfileModal('tab-pwa');
                }
            });

            // Save Profile & Password
            $('#profile-form', body)?.addEventListener('submit', async (e) => {
                e.preventDefault();
                const fd = new FormData(e.target);
                try {
                    const res = await apiPost('change_password', Object.fromEntries(fd.entries()));
                    if (res.user) state.user = res.user;
                    updateUserSidebar();
                    toast('Profil gespeichert.');
                    openProfileModal('tab-profile');
                } catch (err) {
                    toast(err.message, 'error');
                }
            });

            // TOTP Setup
            $('#btn-totp-start', body)?.addEventListener('click', async () => {
                try {
                    const res = await apiPost('totp_setup');
                    const box = $('#totp-setup-box', body);
                    box.classList.remove('hidden');
                    box.innerHTML = `
                        <div style="display:flex;gap:1rem;align-items:center;flex-wrap:wrap">
                            <div>${res.qr_svg}</div>
                            <div style="flex:1;min-width:210px">
                                <p class="small muted" style="margin-top:0">
                                    1. Scannen Sie den QR-Code mit Ihrer Authenticator-App.<br>
                                    <span style="font-size:0.75rem">Manueller Schlüssel: <code>${esc(res.secret)}</code></span>
                                </p>
                                <form id="totp-verify-form">
                                    <div class="form-row">
                                        <input type="text" name="code" class="input" placeholder="6-stelliger Code" pattern="[0-9]*" inputmode="numeric" maxlength="6" required>
                                        <button type="submit" class="btn btn-primary">Aktivieren</button>
                                    </div>
                                </form>
                            </div>
                        </div>
                    `;
                    $('#totp-verify-form', box).querySelector('input').focus();
                    $('#totp-verify-form', box).addEventListener('submit', async (ev) => {
                        ev.preventDefault();
                        try {
                            const code = ev.target.code.value.trim();
                            const enRes = await apiPost('totp_enable', { code });
                            if (enRes.user) state.user = enRes.user;
                            toast('Authenticator-2FA (TOTP) erfolgreich aktiviert!');
                            openProfileModal('tab-2fa');
                        } catch (err) {
                            toast(err.message, 'error');
                        }
                    });
                } catch (err) {
                    toast(err.message, 'error');
                }
            });

            $('#btn-totp-disable', body)?.addEventListener('click', async () => {
                if (!confirm('Authenticator-2FA (TOTP) wirklich deaktivieren?')) return;
                try {
                    const res = await apiPost('totp_disable');
                    if (res.user) state.user = res.user;
                    toast('Authenticator-2FA deaktiviert.');
                    openProfileModal('tab-2fa');
                } catch (err) {
                    toast(err.message, 'error');
                }
            });

            // Register Biometric Passkey
            $('#btn-add-passkey', body)?.addEventListener('click', async () => {
                if (!window.PublicKeyCredential) {
                    toast('Ihr Browser unterstützt keine WebAuthn-Passkeys.', 'error');
                    return;
                }
                try {
                    const opts = await apiPost('passkey_register_options');
                    const publicKey = {
                        rp: { name: opts.rpName, id: opts.rpId },
                        user: {
                            id: b64urlToUint8Array(opts.userIdB64),
                            name: opts.userName,
                            displayName: opts.userDisplayName,
                        },
                        challenge: b64urlToUint8Array(opts.challengeB64),
                        pubKeyCredParams: [
                            { type: 'public-key', alg: -7 },   // ES256
                            { type: 'public-key', alg: -257 }, // RS256
                        ],
                        timeout: 60000,
                        attestation: 'none',
                        authenticatorSelection: {
                            userVerification: 'preferred',
                            residentKey: 'preferred',
                        },
                        excludeCredentials: (opts.excludeCredentials || []).map((c) => ({
                            type: 'public-key',
                            id: b64urlToUint8Array(c.id),
                        })),
                    };

                    const cred = await navigator.credentials.create({ publicKey });
                    if (!cred) return;

                    let spkiB64 = '';
                    let alg = -7;
                    if (typeof cred.response.getPublicKey === 'function') {
                        const spki = cred.response.getPublicKey();
                        if (spki) spkiB64 = bufferToB64url(spki);
                    }
                    if (typeof cred.response.getPublicKeyAlgorithm === 'function') {
                        alg = cred.response.getPublicKeyAlgorithm() || -7;
                    }
                    let authDataB64 = '';
                    if (typeof cred.response.getAuthenticatorData === 'function') {
                        const ad = cred.response.getAuthenticatorData();
                        if (ad) authDataB64 = bufferToB64url(ad);
                    }

                    const devDefault = navigator.platform ? `Biometrie (${navigator.platform})` : 'Biometrie / Passkey';
                    const devName = prompt('Name für dieses Gerät (z. B. Smartphone, Laptop):', devDefault) || devDefault;

                    await apiPost('passkey_register_verify', {
                        credential_id: bufferToB64url(cred.rawId),
                        client_data_json: bufferToB64url(cred.response.clientDataJSON),
                        authenticator_data: authDataB64,
                        public_key_spki: spkiB64,
                        public_key_alg: alg,
                        device_name: devName,
                    });

                    toast('Biometrie / Passkey erfolgreich gespeichert!');
                    openProfileModal('tab-2fa');
                } catch (err) {
                    toast(err.message || 'Passkey-Einrichtung abgebrochen.', 'error');
                }
            });

            // Delete Passkey
            $$('[data-del-pk]', body).forEach((btn) => {
                btn.addEventListener('click', async () => {
                    if (!confirm('Diesen Passkey wirklich entfernen?')) return;
                    try {
                        await apiPost('passkey_delete', { passkey_id: Number(btn.dataset.delPk) });
                        toast('Passkey entfernt.');
                        openProfileModal('tab-2fa');
                    } catch (err) {
                        toast(err.message, 'error');
                    }
                });
            });

            // Email 2FA 2-Step Verification Setup (prevents accidental lockout!)
            $('#btn-email-2fa-start', body)?.addEventListener('click', async (e) => {
                e.target.disabled = true;
                e.target.textContent = 'Sende…';
                try {
                    const res = await apiPost('email_2fa_setup');
                    const box = $('#email-2fa-setup-box', body);
                    box.classList.remove('hidden');
                    box.innerHTML = `
                        <p class="small muted" style="margin-top:0">
                            Ein 6-stelliger Testcode wurde an <strong>${esc(res.masked_email)}</strong> gesendet (bitte ggf. auch im Spam-Ordner prüfen). Erst nach Eingabe des Codes wird E-Mail-2FA aktiviert:
                        </p>
                        <form id="email-2fa-verify-form" class="form-row">
                            <input type="text" name="code" class="input" placeholder="6-stelliger Code" pattern="[0-9]*" inputmode="numeric" maxlength="6" required>
                            <button type="submit" class="btn btn-primary">Bestätigen & Aktivieren</button>
                        </form>
                    `;
                    $('#email-2fa-verify-form', box).querySelector('input').focus();
                    $('#email-2fa-verify-form', box).addEventListener('submit', async (ev) => {
                        ev.preventDefault();
                        try {
                            const code = ev.target.code.value.trim();
                            const enRes = await apiPost('email_2fa_enable', { code });
                            if (enRes.user) state.user = enRes.user;
                            toast('E-Mail-2FA erfolgreich bestätigt und aktiviert!');
                            openProfileModal('tab-2fa');
                        } catch (err) {
                            toast(err.message, 'error');
                        }
                    });
                } catch (err) {
                    toast(err.message, 'error');
                    e.target.disabled = false;
                    e.target.textContent = 'Testcode senden';
                }
            });

            $('#btn-email-2fa-disable', body)?.addEventListener('click', async () => {
                try {
                    const res = await apiPost('email_2fa_disable');
                    if (res.user) state.user = res.user;
                    toast('E-Mail-2FA deaktiviert.');
                    openProfileModal('tab-2fa');
                } catch (err) {
                    toast(err.message, 'error');
                }
            });

            // Toggle Passkey 2FA checkbox
            $('#chk-passkey-2fa', body)?.addEventListener('change', async () => {
                try {
                    const passkey2fa = $('#chk-passkey-2fa', body).checked;
                    await apiPost('toggle_2fa_flags', { passkey_2fa_enabled: passkey2fa });
                    toast('2FA-Einstellung gespeichert.');
                } catch (err) {
                    toast(err.message, 'error');
                    openProfileModal('tab-2fa');
                }
            });
        } catch (err) {
            toast(err.message, 'error');
        }
    }

    // Admin User & Quota Management Modal
    $('#btn-admin-modal')?.addEventListener('click', () => openAdminModal('adm-users'));

    async function openAdminModal(initialTab = 'adm-users') {
        const activeTab = typeof initialTab === 'string' ? initialTab : 'adm-users';
        try {
            const res = await apiGet({ action: 'admin_users' });
            const users = res.users || [];
            const groups = res.groups || [];
            const groupFolders = res.group_folders || [];
            const settings = res.settings || {};

            const rows = users.map((u) => {
                const quotaMb = u.quota_bytes > 0 ? Math.round(u.quota_bytes / 1048576) : 0;
                return `
                    <tr>
                        <td>
                            <strong>${esc(u.display_name)}</strong>
                            <div class="muted small">@${esc(u.username)} · ${u.file_count} Dateien</div>
                        </td>
                        <td>
                            <span class="badge">${u.role === 'admin' ? '👑 Admin' : '👤 User'}</span>
                        </td>
                        <td class="small">
                            ${formatBytes(u.used_bytes)} / ${u.quota_bytes > 0 ? formatBytes(u.quota_bytes) : '∞'}
                        </td>
                        <td style="text-align:right">
                            <button type="button" class="btn btn-ghost btn-sm" data-edit-user='${esc(JSON.stringify({ ...u, quota_mb: quotaMb }))}'>✏️ Bearbeiten</button>
                            ${u.id !== state.user.id ? `<button type="button" class="btn btn-danger btn-sm" data-del-user="${u.id}">🗑️</button>` : ''}
                        </td>
                    </tr>
                `;
            }).join('');

            const groupRows = groups.map((g) => {
                const memberBadges = (g.members || []).map((m) => `<span class="badge">👤 ${esc(m.display_name)}</span>`).join(' ');
                return `
                    <tr>
                        <td><strong>👪 ${esc(g.name)}</strong></td>
                        <td>${memberBadges || '<span class="muted small">Keine Mitglieder</span>'}</td>
                        <td style="text-align:right;white-space:nowrap">
                            <button type="button" class="btn btn-ghost btn-sm" data-edit-grp='${esc(JSON.stringify(g))}'>✏️</button>
                            <button type="button" class="btn btn-danger btn-sm" data-del-grp-adm="${g.id}">🗑️</button>
                        </td>
                    </tr>
                `;
            }).join('');

            const memberCheckboxes = users.map((u) => `
                <label style="display:inline-flex;align-items:center;gap:0.35rem;padding:0.35rem 0.6rem;border:1px solid var(--border);border-radius:8px;cursor:pointer;font-size:0.86rem">
                    <input type="checkbox" name="grp_member" value="${u.id}">
                    <span>${esc(u.display_name)} <span class="muted">(@${esc(u.username)})</span></span>
                </label>
            `).join('');

            const gfRows = groupFolders.map((gf) => {
                const gBadges = (gf.group_names || []).map((gn) => `<span class="badge badge-shared">👪 ${esc(gn)}</span>`).join(' ');
                return `
                    <tr>
                        <td>
                            <strong>📁 ${esc(gf.name)}</strong>
                            <div class="muted small">${gf.file_count} Dateien · ${formatBytes(gf.used_bytes)}</div>
                        </td>
                        <td>${gBadges || '<span class="muted small">—</span>'}</td>
                        <td class="small">${gf.permission === 'write' ? '✏️ Lesen & Schreiben' : '👁️ Nur Lesen'}</td>
                        <td style="text-align:right;white-space:nowrap">
                            <button type="button" class="btn btn-ghost btn-sm" data-edit-gf='${esc(JSON.stringify(gf))}'>✏️</button>
                            <button type="button" class="btn btn-danger btn-sm" data-del-gf="${gf.id}">🗑️</button>
                        </td>
                    </tr>
                `;
            }).join('');

            const gfGroupCheckboxes = groups.map((g) => `
                <label style="display:inline-flex;align-items:center;gap:0.35rem;padding:0.35rem 0.6rem;border:1px solid var(--border);border-radius:8px;cursor:pointer;font-size:0.86rem">
                    <input type="checkbox" name="gf_group" value="${g.id}">
                    <span>👪 ${esc(g.name)} <span class="muted">(${(g.members || []).length})</span></span>
                </label>
            `).join('');

            openModal('⚙️ Administration', `
                <div class="tabs">
                    <button type="button" class="tab-btn ${activeTab === 'adm-users' ? 'active' : ''}" data-adm-tab="adm-users">👥 Benutzer (${users.length})</button>
                    <button type="button" class="tab-btn ${activeTab === 'adm-groups' ? 'active' : ''}" data-adm-tab="adm-groups">👪 Gruppen (${groups.length})</button>
                    <button type="button" class="tab-btn ${activeTab === 'adm-group-folders' ? 'active' : ''}" data-adm-tab="adm-group-folders">📂 Gruppenordner (${groupFolders.length})</button>
                    <button type="button" class="tab-btn ${activeTab === 'adm-settings' ? 'active' : ''}" data-adm-tab="adm-settings">🛠️ System</button>
                    <button type="button" class="tab-btn ${activeTab === 'adm-update' ? 'active' : ''}" data-adm-tab="adm-update">🚀 GitHub Update</button>
                </div>

                <div id="adm-users" class="${activeTab === 'adm-users' ? '' : 'hidden'}">
                    <div class="file-table-wrap" style="margin-bottom:1rem">
                        <table class="file-table">
                            <thead><tr><th>Benutzer</th><th>Rolle</th><th>Speicher / Quota</th><th style="text-align:right">Aktion</th></tr></thead>
                            <tbody>${rows}</tbody>
                        </table>
                    </div>

                    <form id="admin-create-user-form" style="border:1px solid var(--border);border-radius:10px;padding:0.85rem;background:var(--bg)">
                        <h4 style="margin:0 0 0.65rem">➕ Neuen Benutzer anlegen</h4>
                        <div class="form-row" style="margin-bottom:0.75rem">
                            <div style="flex:1">
                                <label class="small muted">Benutzername</label>
                                <input type="text" name="username" class="input" placeholder="z. B. maria" required>
                            </div>
                            <div style="flex:1">
                                <label class="small muted">Anzeigename</label>
                                <input type="text" name="display_name" class="input" placeholder="Maria Muster" required>
                            </div>
                        </div>
                        <div class="form-row" style="margin-bottom:0.75rem">
                            <div style="flex:1">
                                <label class="small muted">Passwort (mind. 6 Zeichen)</label>
                                <input type="password" name="password" class="input" required minlength="6">
                            </div>
                            <div style="width:140px">
                                <label class="small muted">Rolle</label>
                                <select name="role" class="input">
                                    <option value="user">Benutzer</option>
                                    <option value="admin">Administrator</option>
                                </select>
                            </div>
                            <div style="width:160px">
                                <label class="small muted">Quota in MB (0 = ∞)</label>
                                <input type="number" name="quota_mb" class="input" value="5120" min="0">
                            </div>
                        </div>
                        <button type="submit" class="btn btn-primary btn-block">➕ Benutzer anlegen</button>
                    </form>
                </div>

                <div id="adm-groups" class="${activeTab === 'adm-groups' ? '' : 'hidden'}">
                    <p class="small muted" style="margin-top:0">
                        Hier legen Sie Benutzergruppen an und ordnen diesen Mitglieder zu.
                    </p>
                    <div class="file-table-wrap" style="margin-bottom:1rem">
                        <table class="file-table">
                            <thead><tr><th>Gruppe</th><th>Mitglieder</th><th style="text-align:right">Aktion</th></tr></thead>
                            <tbody>${groupRows || '<tr><td colspan="3" class="empty-cell">Noch keine Benutzergruppen angelegt.</td></tr>'}</tbody>
                        </table>
                    </div>

                    <form id="admin-save-group-form" style="border:1px solid var(--border);border-radius:10px;padding:0.85rem;background:var(--bg)">
                        <input type="hidden" name="group_id" id="adm-grp-id" value="">
                        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.6rem">
                            <h4 id="adm-grp-form-title" style="margin:0">➕ Neue Benutzergruppe anlegen</h4>
                            <button type="button" class="btn btn-ghost btn-sm hidden" id="btn-adm-grp-cancel">Abbrechen</button>
                        </div>
                        <div class="form-group">
                            <label class="small muted">Gruppenname (z. B. Team, Vorstand, Buchhaltung)</label>
                            <input type="text" name="name" id="adm-grp-name" class="input" placeholder="Gruppenname…" required>
                        </div>
                        <div class="form-group">
                            <label class="small muted">Mitglieder auswählen</label>
                            <div style="display:flex;flex-wrap:wrap;gap:0.45rem;margin-top:0.25rem">
                                ${memberCheckboxes}
                            </div>
                        </div>
                        <button type="submit" class="btn btn-primary btn-block" id="btn-adm-grp-submit">💾 Gruppe speichern</button>
                    </form>
                </div>

                <div id="adm-group-folders" class="${activeTab === 'adm-group-folders' ? '' : 'hidden'}">
                    <p class="small muted" style="margin-top:0">
                        Hier angelegte Gruppenordner erscheinen automatisch auf der Hauptebene (<strong>📁 Dateien</strong>) aller Mitglieder der zugewiesenen Gruppe(n) – ohne im persönlichen Dateibereich des Administrators aufzutauchen.
                    </p>
                    <div class="file-table-wrap" style="margin-bottom:1rem">
                        <table class="file-table">
                            <thead><tr><th>Gruppenordner</th><th>Zugewiesene Gruppen</th><th>Berechtigung</th><th style="text-align:right">Aktion</th></tr></thead>
                            <tbody>${gfRows || '<tr><td colspan="4" class="empty-cell">Noch keine Gruppenordner angelegt.</td></tr>'}</tbody>
                        </table>
                    </div>

                    ${groups.length > 0 ? `
                    <form id="admin-save-gf-form" style="border:1px solid var(--border);border-radius:10px;padding:0.85rem;background:var(--bg)">
                        <input type="hidden" name="folder_id" id="adm-gf-id" value="">
                        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.6rem">
                            <h4 id="adm-gf-form-title" style="margin:0">➕ Neuen Gruppenordner anlegen</h4>
                            <button type="button" class="btn btn-ghost btn-sm hidden" id="btn-adm-gf-cancel">Abbrechen</button>
                        </div>
                        <div class="form-row" style="margin-bottom:0.75rem">
                            <div style="flex:2">
                                <label class="small muted">Ordnername (z. B. Projekte, Buchhaltung, Team-Austausch)</label>
                                <input type="text" name="name" id="adm-gf-name" class="input" placeholder="Name des Gruppenordners…" required>
                            </div>
                            <div style="flex:1">
                                <label class="small muted">Berechtigung</label>
                                <select name="permission" id="adm-gf-perm" class="input">
                                    <option value="write">✏️ Lesen & Schreiben</option>
                                    <option value="read">👁️ Nur Lesen</option>
                                </select>
                            </div>
                        </div>
                        <div class="form-group">
                            <label class="small muted">Für folgende Benutzergruppe(n) freischalten</label>
                            <div style="display:flex;flex-wrap:wrap;gap:0.45rem;margin-top:0.25rem">
                                ${gfGroupCheckboxes}
                            </div>
                        </div>
                        <button type="submit" class="btn btn-primary btn-block">💾 Gruppenordner speichern</button>
                    </form>` : '<p class="muted small">Bitte legen Sie zuerst im Reiter <strong>👪 Gruppen</strong> mindestens eine Benutzergruppe an.</p>'}
                </div>

                <div id="adm-settings" class="${activeTab === 'adm-settings' ? '' : 'hidden'}">
                    <form id="admin-settings-form">
                        <div class="form-group">
                            <label>Name der Cloud</label>
                            <input type="text" name="app_name" class="input" value="${esc(settings.app_name || 'PureCloud')}" required>
                        </div>
                        <div class="form-group">
                            <label>
                                <input type="checkbox" name="enable_webdav" value="1" ${(settings.enable_webdav ?? '1') === '1' ? 'checked' : ''}>
                                WebDAV-Netzlaufwerk-Schnittstelle aktivieren
                            </label>
                        </div>
                        <div class="form-row" style="margin-bottom:0.75rem">
                            <div style="flex:2">
                                <label class="small muted">GitHub Repository (Owner/Repo)</label>
                                <input type="text" name="github_repo" class="input" value="${esc(settings.github_repo || 'uWiiiDev/PureCloud')}">
                            </div>
                            <div style="flex:1">
                                <label class="small muted">Branch</label>
                                <input type="text" name="github_branch" class="input" value="${esc(settings.github_branch || 'main')}">
                            </div>
                        </div>
                        <div class="form-group" style="margin-bottom:0.85rem">
                            <label class="small muted">Automatische Papierkorb-Leerung (Tage, 0 = nie)</label>
                            <input type="number" name="trash_auto_purge_days" class="input" value="${esc(settings.trash_auto_purge_days ?? '30')}" min="0">
                            <div class="small muted" style="margin-top:0.25rem">Dateien im Papierkorb, die älter als diese Anzahl an Tagen sind, werden automatisch endgültig gelöscht.</div>
                        </div>
                        <button type="submit" class="btn btn-primary">Einstellungen speichern</button>
                    </form>

                    <div style="border:1px solid var(--border);border-radius:10px;padding:0.85rem;background:var(--bg);margin-top:1.25rem">
                        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:0.5rem">
                            <div>
                                <h4 style="margin:0 0 0.2rem">🧹 Speicher-Optimierer (Duplikate-Finder)</h4>
                                <div class="small muted">Findet mehrfach hochgeladene, identische Dateien und gibt Speicherplatz frei.</div>
                            </div>
                            <button type="button" class="btn btn-secondary btn-sm" id="btn-adm-find-duplicates">🔍 Duplikate suchen</button>
                        </div>
                    </div>
                </div>

                <div id="adm-update" class="${activeTab === 'adm-update' ? '' : 'hidden'}">
                    <div style="border:1px solid var(--border);border-radius:10px;padding:1rem;background:var(--bg);margin-bottom:1rem">
                        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:0.75rem;flex-wrap:wrap;gap:0.5rem">
                            <div>
                                <h4 style="margin:0 0 0.25rem;display:flex;align-items:center;gap:0.5rem">
                                    <span>🐙 GitHub Repository</span>
                                    <span id="adm-update-badge" class="badge" style="font-size:0.75rem;padding:0.2rem 0.5rem;background:var(--bg-secondary);border:1px solid var(--border)">Wird geprüft…</span>
                                </h4>
                                <div class="small muted" id="adm-update-repo-info">Ziel: <a href="https://github.com/${esc(settings.github_repo || 'uWiiiDev/PureCloud')}" target="_blank" rel="noopener" style="color:var(--primary);text-decoration:underline">${esc(settings.github_repo || 'uWiiiDev/PureCloud')}</a> (Branch: <code>${esc(settings.github_branch || 'main')}</code>)</div>
                            </div>
                            <button type="button" class="btn btn-secondary btn-sm" id="btn-adm-check-update">🔄 Jetzt prüfen</button>
                        </div>

                        <div id="adm-update-details" style="font-size:0.9rem;line-height:1.5;color:var(--text)">
                            <p class="muted small" style="margin:0.5rem 0">Klicken Sie auf „Jetzt prüfen“ oder wechseln Sie in diesen Tab, um Updates abzufragen.</p>
                        </div>
                    </div>

                    <div id="adm-update-action-box" class="hidden" style="border:1px solid var(--border);border-radius:10px;padding:1rem;background:var(--bg-secondary)">
                        <h4 style="margin:0 0 0.5rem">⚡ Update durchführen</h4>
                        <p class="small muted" style="margin:0 0 0.75rem">
                            Das Update aktualisiert die PureCloud-Dateien direkt vom GitHub-Repository. 
                            <strong>Ihre Daten, Datenbank und Dateien in <code>storage/</code> bleiben garantiert unangetastet.</strong>
                        </p>
                        <button type="button" class="btn btn-primary" id="btn-adm-run-update">
                            🚀 Jetzt auf neueste Version aktualisieren
                        </button>
                    </div>

                    <div id="adm-update-log-box" class="hidden" style="margin-top:1rem;padding:0.75rem;border-radius:8px;background:#1e1e1e;color:#d4d4d4;font-family:monospace;font-size:0.8rem;white-space:pre-wrap;max-height:220px;overflow-y:auto"></div>
                </div>
            `, true);

            const body = $('#modal-body');
            let updateLoaded = false;
            $$('[data-adm-tab]', body).forEach((btn) => {
                btn.addEventListener('click', () => {
                    $$('[data-adm-tab]', body).forEach((b) => b.classList.remove('active'));
                    btn.classList.add('active');
                    ['adm-users', 'adm-groups', 'adm-group-folders', 'adm-settings', 'adm-update'].forEach((id) => {
                        $(`#${id}`, body)?.classList.toggle('hidden', btn.dataset.admTab !== id);
                    });
                    if (btn.dataset.admTab === 'adm-update' && !updateLoaded) {
                        loadUpdateInfo();
                    }
                });
            });

            async function loadUpdateInfo() {
                const badge = $('#adm-update-badge', body);
                const details = $('#adm-update-details', body);
                const actionBox = $('#adm-update-action-box', body);
                const logBox = $('#adm-update-log-box', body);
                if (!badge || !details) return;

                badge.style.background = 'var(--bg-secondary)';
                badge.style.color = 'var(--text-muted)';
                badge.textContent = '⏳ Wird geprüft…';
                details.innerHTML = '<p class="muted small" style="margin:0.5rem 0">Frage GitHub API ab…</p>';
                actionBox?.classList.add('hidden');
                logBox?.classList.add('hidden');

                try {
                    const res = await apiPost('admin_check_update');
                    const d = res.data;
                    updateLoaded = true;

                    const curSha = d.current?.sha ? d.current.sha.substring(0, 7) : 'Unbekannt';
                    const curDate = d.current?.date ? new Date(d.current.date).toLocaleString('de-DE') : '—';
                    const curMsg = d.current?.message || '';

                    const latSha = d.latest?.sha ? d.latest.sha.substring(0, 7) : 'Unbekannt';
                    const latDate = d.latest?.date ? new Date(d.latest.date).toLocaleString('de-DE') : '—';
                    const latMsg = d.latest?.message || '';
                    const latAuthor = d.latest?.author || '';

                    if (d.has_update) {
                        badge.style.background = '#2563eb';
                        badge.style.color = '#fff';
                        badge.textContent = '🚀 Neues Update verfügbar';
                    } else {
                        badge.style.background = '#10b981';
                        badge.style.color = '#fff';
                        badge.textContent = '✅ Auf neuestem Stand';
                    }

                    details.innerHTML = `
                        <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(240px, 1fr));gap:0.75rem;margin-top:0.75rem">
                            <div style="border:1px solid var(--border);border-radius:8px;padding:0.75rem;background:var(--bg-secondary)">
                                <div class="small muted" style="font-weight:600;margin-bottom:0.35rem">📦 Installierte Version</div>
                                <div><strong>Commit:</strong> <code>${curSha}</code></div>
                                <div class="small muted"><strong>Stand:</strong> ${curDate}</div>
                                ${curMsg ? `<div class="small muted" style="margin-top:0.25rem;font-style:italic">„${esc(curMsg.split('\n')[0])}“</div>` : ''}
                                <div class="small muted" style="margin-top:0.35rem;font-size:0.75rem">Modus: ${d.is_git ? 'Git Repository' : 'Direkte Installation (ZIP)'}</div>
                            </div>
                            <div style="border:1px solid var(--border);border-radius:8px;padding:0.75rem;background:var(--bg-secondary)">
                                <div class="small muted" style="font-weight:600;margin-bottom:0.35rem">🌐 Neueste Version auf GitHub</div>
                                <div><strong>Commit:</strong> <code>${latSha}</code></div>
                                <div class="small muted"><strong>Stand:</strong> ${latDate} ${latAuthor ? `(${esc(latAuthor)})` : ''}</div>
                                ${latMsg ? `<div class="small muted" style="margin-top:0.25rem;font-style:italic">„${esc(latMsg.split('\n')[0])}“</div>` : ''}
                                <div class="small muted" style="margin-top:0.35rem;font-size:0.75rem"><a href="https://github.com/${esc(d.repo)}/commit/${latSha}" target="_blank" rel="noopener" style="color:var(--primary)">Auf GitHub ansehen ↗</a></div>
                            </div>
                        </div>
                    `;

                    if (actionBox) {
                        actionBox.classList.remove('hidden');
                        const runBtn = $('#btn-adm-run-update', actionBox);
                        if (runBtn) {
                            if (d.has_update) {
                                runBtn.innerHTML = `🚀 Jetzt auf Version <code>${latSha}</code> aktualisieren`;
                                runBtn.className = 'btn btn-primary';
                            } else {
                                runBtn.innerHTML = `🔄 Neu von GitHub herunterladen (<code>${latSha}</code> erzwingen)`;
                                runBtn.className = 'btn btn-secondary';
                            }
                        }
                    }
                } catch (err) {
                    badge.style.background = '#ef4444';
                    badge.style.color = '#fff';
                    badge.textContent = '⚠️ Abfragefehler';
                    details.innerHTML = `<div style="color:var(--danger);padding:0.5rem 0"><strong>Fehler beim Prüfen:</strong> ${esc(err.message)}</div>`;
                }
            }

            $('#btn-adm-check-update', body)?.addEventListener('click', () => loadUpdateInfo());

            $('#btn-adm-run-update', body)?.addEventListener('click', async (e) => {
                const btn = e.currentTarget;
                if (!confirm('PureCloud jetzt über GitHub aktualisieren?\n\nAlle Anwendungsdateien werden aktualisiert. Ihre Daten, Datenbank und Dateien in storage/ bleiben garantiert erhalten.')) {
                    return;
                }

                const logBox = $('#adm-update-log-box', body);
                btn.disabled = true;
                btn.innerHTML = '⏳ Update wird durchgeführt… Bitte warten…';
                if (logBox) {
                    logBox.classList.remove('hidden');
                    logBox.textContent = '🚀 Starte Update-Vorgang…\nVerbindung zu GitHub wird aufgebaut…\n';
                }

                try {
                    const res = await apiPost('admin_perform_update');
                    const r = res.result;
                    toast(r.message || 'Update erfolgreich installiert!', 'success');
                    if (logBox) {
                        const logs = Array.isArray(r.log) ? r.log.join('\n') : '';
                        logBox.textContent += `\n${logs}\n\n✅ Fertig! Installierter Commit: ${r.new_sha ? r.new_sha.substring(0, 7) : 'OK'}`;
                    }
                    btn.innerHTML = '✅ Update abgeschlossen – Seite wird neu geladen…';
                    btn.className = 'btn btn-primary';
                    btn.disabled = true;
                    setTimeout(() => {
                        window.location.reload();
                    }, 2000);
                } catch (err) {
                    toast(`Update fehlgeschlagen: ${err.message}`, 'error');
                    btn.disabled = false;
                    btn.innerHTML = '❌ Erneut versuchen';
                    if (logBox) {
                        logBox.textContent += `\n❌ FEHLER: ${err.message}\n`;
                    }
                }
            });

            if (activeTab === 'adm-update') {
                loadUpdateInfo();
            }

            // Group Folder create/edit/delete handlers
            $$('[data-edit-gf]', body).forEach((btn) => {
                btn.addEventListener('click', () => {
                    const gf = JSON.parse(btn.dataset.editGf);
                    $('#adm-gf-id', body).value = String(gf.id);
                    $('#adm-gf-name', body).value = gf.name;
                    $('#adm-gf-perm', body).value = gf.permission || 'write';
                    $('#adm-gf-form-title', body).textContent = `✏️ Gruppenordner bearbeiten: ${gf.name}`;
                    $('#btn-adm-gf-cancel', body).classList.remove('hidden');
                    const gIds = new Set((gf.group_ids || []).map(Number));
                    $$('input[name="gf_group"]', body).forEach((chk) => {
                        chk.checked = gIds.has(Number(chk.value));
                    });
                    $('#adm-gf-name', body).focus();
                });
            });

            $('#btn-adm-gf-cancel', body)?.addEventListener('click', () => {
                $('#adm-gf-id', body).value = '';
                $('#adm-gf-name', body).value = '';
                $('#adm-gf-perm', body).value = 'write';
                $('#adm-gf-form-title', body).textContent = '➕ Neuen Gruppenordner anlegen';
                $('#btn-adm-gf-cancel', body).classList.add('hidden');
                $$('input[name="gf_group"]', body).forEach((chk) => {
                    chk.checked = false;
                });
            });

            $('#admin-save-gf-form', body)?.addEventListener('submit', async (e) => {
                e.preventDefault();
                const rawId = $('#adm-gf-id', body).value;
                const name = $('#adm-gf-name', body).value.trim();
                const permission = $('#adm-gf-perm', body).value;
                const groupIds = $$('input[name="gf_group"]:checked', body).map((chk) => Number(chk.value));
                if (groupIds.length === 0) {
                    toast('Bitte mindestens eine Benutzergruppe auswählen.', 'error');
                    return;
                }
                try {
                    await apiPost('admin_save_group_folder', {
                        id: rawId ? Number(rawId) : null,
                        name,
                        group_ids: groupIds,
                        permission,
                    });
                    toast('Gruppenordner gespeichert.');
                    openAdminModal('adm-group-folders');
                    loadCurrentView();
                } catch (err) {
                    toast(err.message, 'error');
                }
            });

            $$('[data-del-gf]', body).forEach((btn) => {
                btn.addEventListener('click', async () => {
                    if (!confirm('Diesen Gruppenordner samt allen darin enthaltenen Dateien wirklich unwiderruflich löschen?')) return;
                    try {
                        await apiPost('admin_delete_group_folder', { id: Number(btn.dataset.delGf) });
                        toast('Gruppenordner gelöscht.');
                        openAdminModal('adm-group-folders');
                        loadCurrentView();
                    } catch (err) {
                        toast(err.message, 'error');
                    }
                });
            });

            // Group create/edit/delete handlers
            $$('[data-edit-grp]', body).forEach((btn) => {
                btn.addEventListener('click', () => {
                    const g = JSON.parse(btn.dataset.editGrp);
                    $('#adm-grp-id', body).value = String(g.id);
                    $('#adm-grp-name', body).value = g.name;
                    $('#adm-grp-form-title', body).textContent = `✏️ Gruppe bearbeiten: ${g.name}`;
                    $('#btn-adm-grp-cancel', body).classList.remove('hidden');
                    const mIds = new Set((g.member_ids || []).map(Number));
                    $$('input[name="grp_member"]', body).forEach((chk) => {
                        chk.checked = mIds.has(Number(chk.value));
                    });
                    $('#adm-grp-name', body).focus();
                });
            });

            $('#btn-adm-grp-cancel', body)?.addEventListener('click', () => {
                $('#adm-grp-id', body).value = '';
                $('#adm-grp-name', body).value = '';
                $('#adm-grp-form-title', body).textContent = '➕ Neue Benutzergruppe anlegen';
                $('#btn-adm-grp-cancel', body).classList.add('hidden');
                $$('input[name="grp_member"]', body).forEach((chk) => {
                    chk.checked = false;
                });
            });

            $('#admin-save-group-form', body)?.addEventListener('submit', async (e) => {
                e.preventDefault();
                const rawId = $('#adm-grp-id', body).value;
                const name = $('#adm-grp-name', body).value.trim();
                const memberIds = $$('input[name="grp_member"]:checked', body).map((chk) => Number(chk.value));
                try {
                    await apiPost('admin_save_group', {
                        id: rawId ? Number(rawId) : null,
                        name,
                        member_ids: memberIds,
                    });
                    toast('Benutzergruppe gespeichert.');
                    openAdminModal('adm-groups');
                    loadCurrentView();
                } catch (err) {
                    toast(err.message, 'error');
                }
            });

            $$('[data-del-grp-adm]', body).forEach((btn) => {
                btn.addEventListener('click', async () => {
                    if (!confirm('Diese Benutzergruppe wirklich löschen?')) return;
                    try {
                        await apiPost('admin_delete_group', { id: Number(btn.dataset.delGrpAdm) });
                        toast('Benutzergruppe gelöscht.');
                        openAdminModal('adm-groups');
                        loadCurrentView();
                    } catch (err) {
                        toast(err.message, 'error');
                    }
                });
            });

            $('#admin-create-user-form', body)?.addEventListener('submit', async (e) => {
                e.preventDefault();
                const fd = new FormData(e.target);
                try {
                    await apiPost('admin_create_user', Object.fromEntries(fd.entries()));
                    toast('Benutzer erstellt.');
                    openAdminModal();
                } catch (err) {
                    toast(err.message, 'error');
                }
            });

            $('#admin-settings-form', body)?.addEventListener('submit', async (e) => {
                e.preventDefault();
                const fd = new FormData(e.target);
                try {
                    const sRes = await apiPost('admin_save_settings', {
                        app_name: fd.get('app_name'),
                        enable_webdav: fd.get('enable_webdav') === '1',
                        github_repo: fd.get('github_repo'),
                        github_branch: fd.get('github_branch'),
                        trash_auto_purge_days: Number(fd.get('trash_auto_purge_days') || 0),
                    });
                    state.appName = sRes.settings.app_name;
                    $('#app-title-text').textContent = state.appName;
                    document.title = state.appName;
                    toast('Einstellungen gespeichert.');
                } catch (err) {
                    toast(err.message, 'error');
                }
            });

            $('#btn-adm-find-duplicates', body)?.addEventListener('click', async () => {
                try {
                    toast('Analysiere Speicher auf Duplikate…');
                    const res = await apiGet({ action: 'admin_find_duplicates' });
                    openDuplicatesModal(res.data);
                } catch (err) {
                    toast(err.message, 'error');
                }
            });

            $$('[data-del-user]', body).forEach((btn) => {
                btn.addEventListener('click', async () => {
                    if (!confirm('Diesen Benutzer und alle seine Dateien wirklich löschen?')) return;
                    try {
                        await apiPost('admin_delete_user', { id: Number(btn.dataset.delUser) });
                        toast('Benutzer gelöscht.');
                        openAdminModal();
                    } catch (err) {
                        toast(err.message, 'error');
                    }
                });
            });

            $$('[data-edit-user]', body).forEach((btn) => {
                btn.addEventListener('click', () => {
                    const u = JSON.parse(btn.dataset.editUser);
                    openEditUserModal(u);
                });
            });
            pushNavigationState();
        } catch (err) {
            toast(err.message, 'error');
        }
    }

    function openDuplicatesModal(data) {
        const groups = data.groups || [];
        const totalWasted = data.total_wasted_bytes || 0;

        if (groups.length === 0) {
            openModal('🧹 Speicher-Optimierer', `
                <div class="empty-state" style="padding:2rem 0">
                    <div class="empty-state-icon">🎉</div>
                    <h3>Keine Duplikate gefunden</h3>
                    <p class="muted">Alle gespeicherten Dateien sind einzigartig. Es wird kein Speicherplatz durch doppelte Dateien verschwendet!</p>
                </div>
            `);
            return;
        }

        const groupsHtml = groups.map((g) => {
            const filesHtml = (g.files || []).map((f, fIdx) => `
                <div class="dup-item-row">
                    <div>
                        <strong>📄 ${esc(f.name)}</strong>
                        <div class="muted small">in 📁 ${esc(f.folder_name || 'Hauptverzeichnis')} · ${esc(f.owner_name)} · ${esc((f.created_at || '').slice(0, 16))}</div>
                    </div>
                    ${fIdx === 0 ? '<span class="badge" style="background:var(--bg-secondary)">Original behalten</span>' : `
                        <button type="button" class="btn btn-danger btn-sm" data-del-dup="${f.id}" data-dup-name="${esc(f.name)}">🗑️ Löschen</button>
                    `}
                </div>
            `).join('');

            return `
                <div class="dup-group-box">
                    <div class="dup-group-header">
                        <span>Datei (${formatBytes(g.size_bytes)}) · ${g.count} Kopien</span>
                        <span class="muted small">${formatBytes(g.wasted_bytes)} verschwendet</span>
                    </div>
                    ${filesHtml}
                </div>
            `;
        }).join('');

        openModal(`🧹 ${groups.length} Duplikat-Gruppe(n) – ${formatBytes(totalWasted)} freigebbar`, `
            <p class="muted small" style="margin-top:0">
                Die folgenden Dateien haben exakt denselben SHA-256-Fingerabdruck. Sie können überflüssige Kopien sicher löschen:
            </p>
            <div style="max-height:460px;overflow-y:auto;padding-right:0.25rem">
                ${groupsHtml}
            </div>
        `, true);

        const mBody = $('#modal-body');
        $$('[data-del-dup]', mBody).forEach((btn) => {
            btn.addEventListener('click', async () => {
                const fId = Number(btn.dataset.delDup);
                const fName = btn.dataset.dupName;
                if (!confirm(`„${fName}“ wirklich löschen?`)) return;
                try {
                    await apiPost('trash', { items: [{ type: 'file', id: fId, name: fName }] });
                    toast(`„${fName}“ gelöscht.`);
                    const fresh = await apiGet({ action: 'admin_find_duplicates' });
                    openDuplicatesModal(fresh.data);
                    loadCurrentView();
                } catch (err) {
                    toast(err.message, 'error');
                }
            });
        });
    }

    function openEditUserModal(u) {
        openModal(`Benutzer bearbeiten: @${u.username}`, `
            <form id="edit-user-form">
                <div class="form-group">
                    <label>Anzeigename</label>
                    <input type="text" name="display_name" class="input" value="${esc(u.display_name)}" required>
                </div>
                <div class="form-row" style="margin-bottom:0.75rem">
                    <div style="flex:1">
                        <label class="small muted">Rolle</label>
                        <select name="role" class="input" ${u.id === state.user.id ? 'disabled' : ''}>
                            <option value="user" ${u.role === 'user' ? 'selected' : ''}>Benutzer</option>
                            <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Administrator</option>
                        </select>
                    </div>
                    <div style="flex:1">
                        <label class="small muted">Speicher-Quota in MB (0 = ∞)</label>
                        <input type="number" name="quota_mb" class="input" value="${u.quota_mb}" min="0" required>
                    </div>
                </div>
                <div class="form-group">
                    <label>Neues Passwort setzen (leer lassen für unverändert)</label>
                    <input type="password" name="new_password" class="input" placeholder="Unverändert">
                </div>
                <div class="form-group">
                    <label>
                        <input type="checkbox" name="is_active" value="1" ${u.is_active ? 'checked' : ''} ${u.id === state.user.id ? 'disabled' : ''}>
                        Konto ist aktiv
                    </label>
                </div>
                <div style="display:flex;gap:0.5rem">
                    <button type="button" class="btn btn-ghost" id="btn-back-admin">← Zurück</button>
                    <button type="submit" class="btn btn-primary" style="flex:1">Speichern</button>
                </div>
            </form>
        `);
        $('#btn-back-admin')?.addEventListener('click', openAdminModal);
        $('#edit-user-form')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const fd = new FormData(e.target);
            try {
                await apiPost('admin_update_user', {
                    id: u.id,
                    display_name: fd.get('display_name'),
                    role: fd.get('role') || u.role,
                    quota_mb: Number(fd.get('quota_mb')),
                    is_active: u.id === state.user.id ? true : fd.get('is_active') === '1',
                    new_password: fd.get('new_password') || '',
                });
                toast('Benutzer aktualisiert.');
                openAdminModal();
                loadCurrentView();
            } catch (err) {
                toast(err.message, 'error');
            }
        });
    }

    // Boot Application
    if (state.user) {
        enterAppShell();
    }
})();
