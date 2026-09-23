// ==UserScript==
// @name         Bunkr Media Batch Downloader
// @namespace    https://chatgpt.com/
// @version      1.1.1
// @description  Adds separate batch buttons for Bunkr videos/images and saves each batch directly into one folder you choose.
// @homepageURL  https://github.com/bomboclaat12369/bunkr-media-batch-downloader
// @updateURL    https://raw.githubusercontent.com/bomboclaat12369/bunkr-media-batch-downloader/main/bunkr_media_batch_downloader.user.js
// @downloadURL  https://raw.githubusercontent.com/bomboclaat12369/bunkr-media-batch-downloader/main/bunkr_media_batch_downloader.user.js
// @author       ChatGPT
// @match        https://bunkr.ch/a/*
// @match        https://bunkr.cr/a/*
// @match        https://bunkr.si/a/*
// @match        https://bunkr.la/a/*
// @match        https://bunkr.ac/a/*
// @match        https://bunkr.fi/a/*
// @match        https://bunkr.black/a/*
// @match        https://bunkr.cat/a/*
// @match        https://bunkr.media/a/*
// @match        https://bunkr.pk/a/*
// @match        https://bunkr.red/a/*
// @match        https://bunkr.site/a/*
// @match        https://bunkr.to/a/*
// @match        https://bunkrr.su/a/*
// @connect      *
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @run-at       document-end
// ==/UserScript==

(() => {
    'use strict';

    const CONFIG = {
        concurrency: 2,
        requestTimeoutMs: 30000,
        retries: 3,
        retryDelayMs: 1200,
        betweenItemsMs: 350,
        apiUrl: 'https://dl.bunkr.cr/api/_001_v2',
        signUrl: 'https://glb-apisign.cdn.cr/sign',
    };

    const VIDEO_EXTS = new Set([
        'mp4', 'webm', 'mov', 'm4v', 'avi', 'mkv', '3gp', 'ts', 'm2ts',
        'wmv', 'flv', 'mpeg', 'mpg'
    ]);

    const IMAGE_EXTS = new Set([
        'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif', 'tif', 'tiff',
        'heic', 'heif'
    ]);

    const state = {
        running: false,
        cancelled: false,
        total: 0,
        finished: 0,
        downloaded: 0,
        failed: 0,
        skipped: 0,
        failures: [],
        targetKind: null,
        directoryHandle: null,
        activeRequests: new Set(),
    };

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    function extensionOf(name) {
        const clean = String(name || '').split(/[?#]/)[0].trim();
        const match = clean.match(/\.([a-z0-9]+)$/i);
        return match ? match[1].toLowerCase() : '';
    }

    function kindFrom(name, siteType = '') {
        const t = String(siteType || '').toLowerCase();
        if (t.includes('video')) return 'video';
        if (t.includes('image') || t.includes('photo')) return 'image';

        const ext = extensionOf(name);
        if (VIDEO_EXTS.has(ext)) return 'video';
        if (IMAGE_EXTS.has(ext)) return 'image';
        return 'other';
    }

    function safeFilename(name) {
        const cleaned = String(name || 'bunkr_file')
            .replace(/[\\/:*?"<>|\x00-\x1F]/g, '_')
            .replace(/[. ]+$/g, '')
            .trim();
        return (cleaned || 'bunkr_file').slice(0, 220);
    }

    function pageFileName(card, link, index) {
        const selectors = [
            '.theName',
            '.grid-images_box-txt p',
            '.grid-images_box-txt',
            '[class*="name"]'
        ];

        for (const selector of selectors) {
            const text = card?.querySelector(selector)?.textContent?.trim();
            if (text) return text;
        }

        const title = link?.getAttribute('title')?.trim();
        if (title) return title;

        const alt = link?.querySelector('img')?.getAttribute('alt')?.trim();
        if (alt) return alt;

        const text = link?.textContent?.trim();
        if (text && text.length < 300) return text;

        return `Bunkr file ${index + 1}`;
    }

    function siteTypeFromCard(card) {
        if (!card) return '';
        const elements = [card, ...card.querySelectorAll('[class*="type-"]')];
        for (const el of elements) {
            for (const cls of el.classList || []) {
                if (cls.startsWith('type-')) return cls.slice(5);
            }
        }
        return '';
    }

    function scanAlbum() {
        const seen = new Set();
        const items = [];

        const cards = [...document.querySelectorAll('.theItem')];
        if (cards.length) {
            cards.forEach((card, index) => {
                const link = card.querySelector('a[href*="/f/"]');
                if (!link) return;

                let url;
                try { url = new URL(link.href, location.href); }
                catch { return; }

                if (!url.pathname.includes('/f/')) return;
                const key = `${url.origin}${url.pathname}`;
                if (seen.has(key)) return;
                seen.add(key);

                const name = pageFileName(card, link, index);
                const siteType = siteTypeFromCard(card);
                items.push({
                    pageUrl: url.href,
                    slug: url.pathname.split('/').filter(Boolean).pop() || key,
                    name,
                    siteType,
                    kind: kindFrom(name, siteType),
                });
            });
        }

        // Fallback if Bunkr changes the card wrapper but still exposes /f/ links.
        if (!items.length) {
            [...document.querySelectorAll('a[href*="/f/"]')].forEach((link, index) => {
                let url;
                try { url = new URL(link.href, location.href); }
                catch { return; }

                if (!url.pathname.includes('/f/')) return;
                const key = `${url.origin}${url.pathname}`;
                if (seen.has(key)) return;
                seen.add(key);

                const card = link.closest('.theItem') || link.parentElement;
                const name = pageFileName(card, link, index);
                const siteType = siteTypeFromCard(card);
                items.push({
                    pageUrl: url.href,
                    slug: url.pathname.split('/').filter(Boolean).pop() || key,
                    name,
                    siteType,
                    kind: kindFrom(name, siteType),
                });
            });
        }

        return items;
    }

    function gmRequest(options) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                timeout: CONFIG.requestTimeoutMs,
                ...options,
                onload: resolve,
                onerror: err => reject(new Error(`Network error: ${options.url} (${err?.error || 'unknown'})`)),
                ontimeout: () => reject(new Error(`Timed out: ${options.url}`)),
            });
        });
    }

    async function requestWithRetry(options, label) {
        let lastError;
        for (let attempt = 1; attempt <= CONFIG.retries; attempt++) {
            if (state.cancelled) throw new Error('Cancelled');
            try {
                const response = await gmRequest(options);
                if (response.status >= 200 && response.status < 300) return response;
                throw new Error(`${label} returned HTTP ${response.status}`);
            } catch (error) {
                lastError = error;
                if (attempt < CONFIG.retries) {
                    await sleep(CONFIG.retryDelayMs * attempt);
                }
            }
        }
        throw lastError || new Error(`${label} failed`);
    }

    function findLikelyMediaObject(root, fallbackName) {
        const wantedExt = extensionOf(fallbackName);
        const candidates = [];
        const visited = new Set();

        function walk(value, depth = 0) {
            if (!value || typeof value !== 'object' || depth > 12 || visited.has(value)) return;
            visited.add(value);

            if (Array.isArray(value)) {
                for (const child of value) walk(child, depth + 1);
                return;
            }

            const id = value.id;
            const numericId = id != null && /^\d{4,14}$/.test(String(id));
            if (numericId) {
                const name = value.original || value.filename || value.name || '';
                const type = value.type || value.mime || value.extension || '';
                let score = 1;
                if (name) score += 4;
                if (type) score += 2;
                if (value.slug) score += 2;
                if (value.path || value.cdnEndpoint) score += 2;
                if (wantedExt && extensionOf(name) === wantedExt) score += 5;
                candidates.push({ id: String(id), name, score });
            }

            for (const child of Object.values(value)) walk(child, depth + 1);
        }

        walk(root);
        candidates.sort((a, b) => b.score - a.score);
        return candidates[0] || null;
    }

    function extractNumericId(html, fallbackName) {
        // Preferred: parse Next.js page data if present.
        const nextMatch = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
        if (nextMatch) {
            try {
                const data = JSON.parse(nextMatch[1]);
                const pp = data?.props?.pageProps || {};
                const directKeys = ['file', 'media', 'item', 'video', 'image', 'data'];
                for (const key of directKeys) {
                    const obj = pp?.[key];
                    if (obj?.id != null && /^\d{4,14}$/.test(String(obj.id))) {
                        return {
                            id: String(obj.id),
                            name: obj.original || obj.filename || obj.name || fallbackName,
                        };
                    }
                }

                const found = findLikelyMediaObject(data, fallbackName);
                if (found) return { id: found.id, name: found.name || fallbackName };
            } catch {
                // Continue to regex fallbacks.
            }
        }

        const dlMatch = html.match(/https?:\/\/dl\.bunkr\.cr\/file\/(\d{4,14})/i);
        if (dlMatch) return { id: dlMatch[1], name: fallbackName };

        const ids = [...html.matchAll(/["']id["']\s*:\s*["']?(\d{5,14})["']?/g)];
        if (ids.length) return { id: ids[ids.length - 1][1], name: fallbackName };

        throw new Error('Could not find this file\'s Bunkr numeric ID');
    }

    async function resolveDownload(item) {
        const pageResponse = await requestWithRetry({
            method: 'GET',
            url: item.pageUrl,
            headers: {
                'Referer': location.href,
                'User-Agent': navigator.userAgent,
            },
        }, 'File page');

        const { id, name: pageName } = extractNumericId(pageResponse.responseText || '', item.name);

        const apiResponse = await requestWithRetry({
            method: 'POST',
            url: CONFIG.apiUrl,
            headers: {
                'Content-Type': 'application/json',
                'Origin': 'https://dl.bunkr.cr',
                'Referer': 'https://dl.bunkr.cr/',
                'User-Agent': navigator.userAgent,
            },
            data: JSON.stringify({ id }),
        }, 'Bunkr download API');

        let api;
        try { api = JSON.parse(apiResponse.responseText); }
        catch { throw new Error('Bunkr download API returned invalid JSON'); }

        if (!api?.mediafiles || !api?.path) {
            throw new Error('Bunkr download API response is missing mediafiles/path');
        }

        const signResponse = await requestWithRetry({
            method: 'GET',
            url: `${CONFIG.signUrl}?path=${encodeURIComponent(api.path)}`,
            headers: {
                'Origin': 'https://dl.bunkr.cr',
                'Referer': 'https://dl.bunkr.cr/',
                'User-Agent': navigator.userAgent,
            },
        }, 'Bunkr signing API');

        let sign;
        try { sign = JSON.parse(signResponse.responseText); }
        catch { throw new Error('Bunkr signing API returned invalid JSON'); }

        if (!sign?.token || !sign?.ex) {
            throw new Error('Bunkr signing API response is missing token/ex');
        }

        const filename = api.original || pageName || item.name || item.slug;
        const base = String(api.mediafiles).replace(/\/$/, '');
        const path = String(api.path).startsWith('/') ? String(api.path) : `/${api.path}`;
        const url = `${base}${path}?n=${encodeURIComponent(filename)}&token=${encodeURIComponent(sign.token)}&ex=${encodeURIComponent(sign.ex)}`;

        return { url, filename };
    }

    async function chooseDestinationFolder() {
        const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
        const picker = pageWindow?.showDirectoryPicker;
    
        if (typeof picker !== 'function') {
            throw new Error('Your browser does not support folder selection. Use current Chrome/Edge and run the script on the normal Bunkr album page.');
        }
    
        try {
            return await picker.call(pageWindow, {
                mode: 'readwrite',
                startIn: 'downloads',
            });
        } catch (error) {
            if (error?.name === 'AbortError') return null;
            throw error;
        }
    }

    async function createUniqueFileHandle(directoryHandle, filename) {
        const clean = safeFilename(filename);
        const dot = clean.lastIndexOf('.');
        const hasExt = dot > 0 && dot < clean.length - 1;
        const base = hasExt ? clean.slice(0, dot) : clean;
        const ext = hasExt ? clean.slice(dot) : '';
    
        for (let index = 0; index < 10000; index++) {
            const candidate = index === 0 ? clean : `${base} (${index})${ext}`;
            try {
                await directoryHandle.getFileHandle(candidate, { create: false });
            } catch (error) {
                if (error?.name !== 'NotFoundError') throw error;
                const handle = await directoryHandle.getFileHandle(candidate, { create: true });
                return { handle, filename: candidate };
            }
        }
    
        throw new Error(`Could not create a unique filename for ${clean}`);
    }

    async function downloadToFolder(url, filename, directoryHandle) {
        const { handle, filename: outputName } = await createUniqueFileHandle(directoryHandle, filename);
        const writable = await handle.createWritable();
    
        return new Promise((resolve, reject) => {
            let settled = false;
            let request = null;
    
            const cleanup = () => {
                if (request) state.activeRequests.delete(request);
            };
    
            const fail = async error => {
                if (settled) return;
                settled = true;
                cleanup();
                try { await writable.abort(); } catch {}
                try { await directoryHandle.removeEntry(outputName); } catch {}
                reject(error instanceof Error ? error : new Error(String(error)));
            };
    
            request = GM_xmlhttpRequest({
                method: 'GET',
                url,
                responseType: 'stream',
                timeout: 0,
                onloadstart: async response => {
                    try {
                        if (response.status && (response.status < 200 || response.status >= 300)) {
                            throw new Error(`Download returned HTTP ${response.status}`);
                        }
    
                        const stream = response.response;
                        if (!stream || typeof stream.getReader !== 'function') {
                            throw new Error('Tampermonkey streaming is unavailable. Update Tampermonkey to the current version and try again.');
                        }
    
                        const reader = stream.getReader();
                        while (true) {
                            if (state.cancelled) {
                                try { await reader.cancel(); } catch {}
                                throw new Error('Cancelled');
                            }
    
                            const { done, value } = await reader.read();
                            if (done) break;
                            await writable.write(value);
                        }
    
                        await writable.close();
                        if (!settled) {
                            settled = true;
                            cleanup();
                            resolve({ filename: outputName });
                        }
                    } catch (error) {
                        await fail(error);
                    }
                },
                onload: response => {
                    if (response.status < 200 || response.status >= 300) {
                        fail(new Error(`Download returned HTTP ${response.status}`));
                    }
                },
                onerror: err => fail(new Error(`Download failed (${err?.error || 'network error'})`)),
                ontimeout: () => fail(new Error('Download timed out')),
                onabort: () => fail(new Error(state.cancelled ? 'Cancelled' : 'Download aborted')),
            });
    
            state.activeRequests.add(request);
        });
    }

    async function downloadOne(item, targetKind) {
        let lastError;
    
        for (let attempt = 1; attempt <= CONFIG.retries; attempt++) {
            if (state.cancelled) throw new Error('Cancelled');
            try {
                setStatus(`Resolving: ${item.name}`);
                const resolved = await resolveDownload(item);
                const resolvedKind = kindFrom(resolved.filename, item.siteType);
    
                if (resolvedKind !== targetKind) {
                    return { skipped: true, reason: `Resolved as ${resolvedKind}` };
                }
    
                setStatus(`Downloading to ${state.directoryHandle?.name || 'selected folder'}: ${resolved.filename}`);
                await downloadToFolder(resolved.url, resolved.filename, state.directoryHandle);
                return { skipped: false };
            } catch (error) {
                lastError = error;
                if (attempt < CONFIG.retries && !state.cancelled) {
                    setStatus(`Retry ${attempt}/${CONFIG.retries - 1}: ${item.name}`);
                    await sleep(CONFIG.retryDelayMs * attempt);
                }
            }
        }
    
        throw lastError || new Error('Download failed');
    }

    function candidatesFor(targetKind) {
        const all = scanAlbum();
        // Include "other" so an unusual extension/card can still be resolved and classified correctly.
        return all.filter(item => item.kind === targetKind || item.kind === 'other');
    }

    async function runBatch(targetKind) {
        if (state.running) return;
    
        const all = scanAlbum();
        const knownTarget = all.filter(item => item.kind === targetKind);
        const unknown = all.filter(item => item.kind === 'other');
        const queue = [...knownTarget, ...unknown];
    
        if (!all.length) {
            setStatus('No Bunkr files found on this album page.');
            return;
        }
    
        if (!queue.length) {
            setStatus(`No ${targetKind === 'video' ? 'videos' : 'images'} found.`);
            return;
        }
    
        setStatus('Choose the folder where this batch should be saved…');
        let directoryHandle;
        try {
            directoryHandle = await chooseDestinationFolder();
        } catch (error) {
            setStatus(`Folder picker error: ${error.message}`);
            return;
        }
    
        if (!directoryHandle) {
            setStatus('Folder selection cancelled. Nothing was downloaded.');
            return;
        }
    
        Object.assign(state, {
            running: true,
            cancelled: false,
            total: queue.length,
            finished: 0,
            downloaded: 0,
            failed: 0,
            skipped: 0,
            failures: [],
            targetKind,
            directoryHandle,
        });
    
        state.activeRequests.clear();
        setButtonsRunning(true);
        updateProgress();
        setStatus(`Saving ${targetKind === 'video' ? 'videos' : 'images'} to “${directoryHandle.name}”…`);
    
        let cursor = 0;
    
        async function worker() {
            while (!state.cancelled) {
                const index = cursor++;
                if (index >= queue.length) return;
                const item = queue[index];
    
                try {
                    const result = await downloadOne(item, targetKind);
                    if (result.skipped) state.skipped++;
                    else state.downloaded++;
                } catch (error) {
                    if (state.cancelled) return;
                    state.failed++;
                    state.failures.push({ item: item.name, error: error.message });
                    console.warn('[Bunkr Batch Downloader]', item.name, error);
                } finally {
                    if (!state.cancelled) {
                        state.finished++;
                        updateProgress();
                    }
                }
    
                await sleep(CONFIG.betweenItemsMs);
            }
        }
    
        await Promise.all(Array.from({ length: Math.min(CONFIG.concurrency, queue.length) }, worker));
    
        state.running = false;
        setButtonsRunning(false);
    
        if (state.cancelled) {
            setStatus(`Cancelled — ${state.downloaded} downloaded before stopping.`);
            return;
        }
    
        const kindLabel = targetKind === 'video' ? 'videos' : 'images';
        const parts = [`Done — ${state.downloaded} ${kindLabel} downloaded`];
        if (state.failed) parts.push(`${state.failed} failed`);
        if (state.skipped) parts.push(`${state.skipped} non-${targetKind} skipped`);
        setStatus(parts.join(', ') + '.');
    
        if (state.failures.length) {
            console.table(state.failures);
        }
    
        refreshCounts();
    }

    function cancelBatch() {
        if (!state.running) return;
        state.cancelled = true;
        setStatus('Stopping current download(s)…');
        for (const request of [...state.activeRequests]) {
            try { request.abort(); } catch {}
        }
        const stop = document.getElementById('cbk-stop');
        if (stop) stop.disabled = true;
    }

    function setStatus(text) {
        const el = document.getElementById('cbk-status');
        if (el) el.textContent = text;
    }

    function updateProgress() {
        const bar = document.getElementById('cbk-progress');
        const label = document.getElementById('cbk-progress-label');
        const pct = state.total ? Math.round((state.finished / state.total) * 100) : 0;
        if (bar) bar.style.width = `${pct}%`;
        if (label) {
            label.textContent = state.running
                ? `${state.finished}/${state.total} processed • ${state.downloaded} downloaded • ${state.failed} failed`
                : '';
        }
    }

    function setButtonsRunning(running) {
        const video = document.getElementById('cbk-videos');
        const image = document.getElementById('cbk-images');
        const stop = document.getElementById('cbk-stop');
        if (video) video.disabled = running;
        if (image) image.disabled = running;
        if (stop) {
            stop.disabled = !running;
            stop.style.display = running ? 'block' : 'none';
        }
    }

    function refreshCounts() {
        const items = scanAlbum();
        const videos = items.filter(x => x.kind === 'video').length;
        const images = items.filter(x => x.kind === 'image').length;
        const unknown = items.filter(x => x.kind === 'other').length;

        const videoBtn = document.getElementById('cbk-videos');
        const imageBtn = document.getElementById('cbk-images');
        const counts = document.getElementById('cbk-counts');

        if (videoBtn) videoBtn.textContent = `Download All Videos (${videos})`;
        if (imageBtn) imageBtn.textContent = `Download All Images (${images})`;
        if (counts) {
            counts.textContent = `${items.length} files detected${unknown ? ` • ${unknown} will be classified when resolved` : ''}`;
        }
    }

    function injectUi() {
        if (document.getElementById('cbk-panel')) return;

        const style = document.createElement('style');
        style.textContent = `
            #cbk-panel {
                position: fixed;
                right: 20px;
                bottom: 20px;
                z-index: 2147483647;
                width: 320px;
                padding: 14px;
                border-radius: 12px;
                background: rgba(16, 16, 18, .96);
                border: 1px solid rgba(255,255,255,.12);
                box-shadow: 0 12px 38px rgba(0,0,0,.45);
                color: #f5f5f5;
                font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            }
            #cbk-title { font-weight: 700; font-size: 14px; margin-bottom: 4px; }
            #cbk-counts { color: #a8a8ad; font-size: 11px; margin-bottom: 10px; }
            .cbk-button {
                display: block;
                width: 100%;
                border: 0;
                border-radius: 8px;
                padding: 10px 12px;
                margin-top: 8px;
                font-weight: 700;
                cursor: pointer;
                color: white;
            }
            .cbk-button:disabled { opacity: .45; cursor: default; }
            #cbk-videos { background: #2563eb; }
            #cbk-images { background: #7c3aed; }
            #cbk-stop { background: #b91c1c; display: none; }
            #cbk-track {
                height: 6px;
                background: #29292e;
                border-radius: 99px;
                overflow: hidden;
                margin-top: 12px;
            }
            #cbk-progress {
                width: 0;
                height: 100%;
                background: #22c55e;
                transition: width .2s ease;
            }
            #cbk-progress-label, #cbk-status {
                margin-top: 7px;
                font-size: 11px;
                line-height: 1.35;
                color: #c7c7cc;
                word-break: break-word;
            }
            #cbk-status { color: #ededf0; }
        `;
        document.head.appendChild(style);

        const panel = document.createElement('div');
        panel.id = 'cbk-panel';
        panel.innerHTML = `
            <div id="cbk-title">Bunkr Batch Downloader</div>
            <div id="cbk-counts">Scanning album…</div>
            <button class="cbk-button" id="cbk-videos">Download All Videos</button>
            <button class="cbk-button" id="cbk-images">Download All Images</button>
            <button class="cbk-button" id="cbk-stop">Stop</button>
            <div id="cbk-track"><div id="cbk-progress"></div></div>
            <div id="cbk-progress-label"></div>
            <div id="cbk-status">Ready. Click a batch button, then choose its destination folder once.</div>
        `;
        document.body.appendChild(panel);

        document.getElementById('cbk-videos').addEventListener('click', () => runBatch('video'));
        document.getElementById('cbk-images').addEventListener('click', () => runBatch('image'));
        document.getElementById('cbk-stop').addEventListener('click', cancelBatch);

        refreshCounts();
        setTimeout(refreshCounts, 1200);
        setTimeout(refreshCounts, 3000);
    }

    injectUi();
})();