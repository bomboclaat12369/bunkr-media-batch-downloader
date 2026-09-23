// ==UserScript==
// @name         Bunkr Media Batch Downloader
// @namespace    https://chatgpt.com/
// @version      1.3.0
// @description  Batch-download Bunkr videos or images into one folder you choose, with robust streaming and safe failure limits.
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
        concurrency: 1,
        requestTimeoutMs: 30000,
        retries: 2,
        retryDelayMs: 2500,
        betweenItemsMs: 900,
        maxConsecutiveFailures: 3,
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
        consecutiveFailures: 0,
        lastError: '',
        abortReason: '',
        safeNameCounter: 0,
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

    function truncateByCharacters(value, maxLength) {
        return Array.from(String(value || '')).slice(0, maxLength).join('');
    }

    function safeFilename(name, aggressive = false) {
        let cleaned = String(name || 'bunkr_file');

        try {
            cleaned = cleaned.normalize('NFKC');
        } catch {}

        cleaned = cleaned
            .replace(/[\\/:*?"<>|\u0000-\u001F\u007F-\u009F]/g, '_')
            .replace(/[\r\n\u2028\u2029]/g, '_')
            .replace(/\s+/g, ' ')
            .replace(/^[. ]+|[. ]+$/g, '')
            .trim();

        if (aggressive) {
            cleaned = cleaned
                .replace(/[^A-Za-z0-9._()\- ]+/g, '_')
                .replace(/_+/g, '_')
                .replace(/^[. ]+|[. ]+$/g, '');
        }

        if (!cleaned || cleaned === '.' || cleaned === '..') {
            cleaned = 'bunkr_file';
        }

        const dot = cleaned.lastIndexOf('.');
        const hasExt = dot > 0 && dot < cleaned.length - 1;
        let base = hasExt ? cleaned.slice(0, dot) : cleaned;
        let ext = hasExt ? cleaned.slice(dot) : '';

        // Windows-reserved device names can be rejected even when an extension is present.
        if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base)) {
            base = `_${base}`;
        }

        // Keep filenames conservative so long destination paths and multi-byte names
        // do not trip Chromium/Windows filename limits.
        ext = truncateByCharacters(ext, 16);
        const maxTotal = aggressive ? 80 : 120;
        const maxBase = Math.max(16, maxTotal - Array.from(ext).length);
        base = truncateByCharacters(base, maxBase).replace(/[. ]+$/g, '');

        if (!base) base = 'bunkr_file';
        return `${base}${ext}`;
    }

    function addFilenameSuffix(filename, suffix) {
        const clean = String(filename || 'bunkr_file');
        const dot = clean.lastIndexOf('.');
        const hasExt = dot > 0 && dot < clean.length - 1;
        const base = hasExt ? clean.slice(0, dot) : clean;
        const ext = hasExt ? clean.slice(dot) : '';
        const suffixText = suffix ? ` (${suffix})` : '';
        const maxBase = Math.max(12, 120 - Array.from(ext).length - Array.from(suffixText).length);
        return `${truncateByCharacters(base, maxBase).replace(/[. ]+$/g, '') || 'bunkr_file'}${suffixText}${ext}`;
    }

    function isInvalidFilenameError(error) {
        const message = String(error?.message || '');
        return error?.name === 'TypeError' || /name is not allowed|invalid.*(?:file)?name/i.test(message);
    }

    function filenameFallbacks(filename) {
        const normal = safeFilename(filename, false);
        const aggressive = safeFilename(filename, true);
        const ext = extensionOf(normal);
        const generated = `bunkr_file_${++state.safeNameCounter}${ext ? `.${ext}` : ''}`;

        return [...new Set([normal, aggressive, generated])];
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
        const baseCandidates = filenameFallbacks(filename);

        for (const baseCandidate of baseCandidates) {
            for (let index = 0; index < 1000; index++) {
                const candidate = addFilenameSuffix(baseCandidate, index || '');

                try {
                    await directoryHandle.getFileHandle(candidate, { create: false });
                } catch (error) {
                    if (isInvalidFilenameError(error)) {
                        // Try the next, more conservative filename form.
                        break;
                    }

                    if (error?.name !== 'NotFoundError') throw error;

                    try {
                        const handle = await directoryHandle.getFileHandle(candidate, { create: true });
                        return {
                            handle,
                            filename: candidate,
                            renamed: candidate !== filename,
                        };
                    } catch (createError) {
                        if (isInvalidFilenameError(createError)) {
                            // The OS/browser rejected this name. Fall back automatically
                            // rather than treating the media download itself as failed.
                            break;
                        }
                        throw createError;
                    }
                }
            }
        }

        throw new Error(
            `Could not create a valid local filename for "${safeFilename(filename, true)}"`
        );
    }

    function errorText(error) {
        if (!error) return 'Unknown error';
        const name = error.name && error.name !== 'Error' ? `${error.name}: ` : '';
        return `${name}${error.message || String(error)}`;
    }

    async function normalizeChunk(value) {
        if (value == null) return null;

        if (ArrayBuffer.isView(value)) {
            const source = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
            const copy = new Uint8Array(source.byteLength);
            copy.set(source);
            return copy;
        }

        if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') {
            const source = new Uint8Array(value);
            const copy = new Uint8Array(source.byteLength);
            copy.set(source);
            return copy;
        }

        if (typeof value.arrayBuffer === 'function') {
            const buffer = await value.arrayBuffer();
            const source = new Uint8Array(buffer);
            const copy = new Uint8Array(source.byteLength);
            copy.set(source);
            return copy;
        }

        throw new Error(`Unsupported download chunk type: ${Object.prototype.toString.call(value)}`);
    }

    function toPageRealmBytes(bytes) {
        const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
        const PageUint8Array = pageWindow?.Uint8Array || Uint8Array;
        const output = new PageUint8Array(bytes.byteLength);
        output.set(bytes);
        return output;
    }

    async function copyReaderToFile(reader, fileHandle) {
        const writable = await fileHandle.createWritable();
        let position = 0;

        try {
            while (true) {
                if (state.cancelled) {
                    try { await reader.cancel(); } catch {}
                    throw new Error('Cancelled');
                }

                const { done, value } = await reader.read();
                if (done) break;

                const bytes = await normalizeChunk(value);
                if (!bytes?.byteLength) continue;

                const pageBytes = toPageRealmBytes(bytes);
                await writable.write({
                    type: 'write',
                    position,
                    data: pageBytes,
                });
                position += pageBytes.byteLength;
            }

            await writable.close();
            return position;
        } catch (error) {
            try { await writable.abort(); } catch {}
            throw error;
        }
    }

    async function downloadWithNativeFetch(url, fileHandle) {
        const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
        const fetchFn = pageWindow?.fetch;
        if (typeof fetchFn !== 'function') throw new Error('Native fetch is unavailable');

        const response = await fetchFn.call(pageWindow, url, {
            method: 'GET',
            credentials: 'omit',
            cache: 'no-store',
            redirect: 'follow',
        });

        if (!response.ok) {
            const error = new Error(`CDN download returned HTTP ${response.status}`);
            error.status = response.status;
            throw error;
        }
        if (!response.body?.getReader) throw new Error('Native download stream is unavailable');

        return copyReaderToFile(response.body.getReader(), fileHandle);
    }

    function downloadWithGmStream(url, fileHandle) {
        return new Promise((resolve, reject) => {
            let settled = false;
            let streamStarted = false;
            let request = null;

            const cleanup = () => {
                if (request) state.activeRequests.delete(request);
            };

            const fail = error => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(error instanceof Error ? error : new Error(String(error)));
            };

            request = GM_xmlhttpRequest({
                method: 'GET',
                url,
                responseType: 'stream',
                anonymous: true,
                fetch: true,
                timeout: 0,
                onloadstart: response => {
                    streamStarted = true;

                    if (response.status && (response.status < 200 || response.status >= 300)) {
                        const error = new Error(`CDN download returned HTTP ${response.status}`);
                        error.status = response.status;
                        fail(error);
                        try { request?.abort(); } catch {}
                        return;
                    }

                    const stream = response.response;
                    if (!stream || typeof stream.getReader !== 'function') {
                        fail(new Error('Tampermonkey did not provide a readable download stream'));
                        try { request?.abort(); } catch {}
                        return;
                    }

                    (async () => {
                        try {
                            const bytes = await copyReaderToFile(stream.getReader(), fileHandle);
                            if (!settled) {
                                settled = true;
                                cleanup();
                                resolve(bytes);
                            }
                        } catch (error) {
                            try { request?.abort(); } catch {}
                            fail(error);
                        }
                    })();
                },
                onload: response => {
                    if (response.status < 200 || response.status >= 300) {
                        const error = new Error(`CDN download returned HTTP ${response.status}`);
                        error.status = response.status;
                        fail(error);
                    } else if (!streamStarted) {
                        fail(new Error('Tampermonkey completed the request without exposing its download stream'));
                    }
                },
                onerror: err => fail(new Error(`CDN download network error (${err?.error || 'unknown'})`)),
                ontimeout: () => fail(new Error('CDN download timed out')),
                onabort: () => fail(new Error(state.cancelled ? 'Cancelled' : 'CDN download aborted')),
            });

            state.activeRequests.add(request);
        });
    }

    async function downloadToFolder(url, filename, directoryHandle) {
        const { handle, filename: outputName } = await createUniqueFileHandle(directoryHandle, filename);
        let nativeError = null;

        try {
            await downloadWithNativeFetch(url, handle);
            return { filename: outputName, method: 'native-stream' };
        } catch (error) {
            nativeError = error;
            if (state.cancelled) throw error;
            console.debug('[Bunkr Batch Downloader] Native stream unavailable; trying Tampermonkey stream', error);
        }

        try {
            await downloadWithGmStream(url, handle);
            return { filename: outputName, method: 'gm-stream' };
        } catch (gmError) {
            try { await directoryHandle.removeEntry(outputName); } catch {}
            throw new Error(
                `Folder download failed. Native: ${errorText(nativeError)} | Tampermonkey: ${errorText(gmError)}`
            );
        }
    }

    async function downloadOne(item, targetKind) {
        let lastError;
        let resolvedFilename = item.name;

        for (let attempt = 1; attempt <= CONFIG.retries; attempt++) {
            if (state.cancelled) throw new Error('Cancelled');
            try {
                setStatus(`Resolving: ${item.name}`);
                const resolved = await resolveDownload(item);
                resolvedFilename = resolved.filename || item.name;
                const resolvedKind = kindFrom(resolved.filename, item.siteType);

                if (resolvedKind !== targetKind) {
                    return { skipped: true, reason: `Resolved as ${resolvedKind}` };
                }

                setStatus(`Downloading to ${state.directoryHandle?.name || 'selected folder'}: ${resolved.filename}`);
                await downloadToFolder(resolved.url, resolved.filename, state.directoryHandle);
                return { skipped: false };
            } catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                lastError.downloadName = resolvedFilename || item.name;
                if (attempt < CONFIG.retries && !state.cancelled) {
                    setStatus(`Retry ${attempt}/${CONFIG.retries - 1}: ${resolvedFilename || item.name} — ${errorText(lastError)}`);
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

    async function runBatch(targetKind, retryQueue = null) {
        if (state.running) return;

        const isRetry = Array.isArray(retryQueue);
        const all = isRetry ? [] : scanAlbum();
        const knownTarget = isRetry ? [] : all.filter(item => item.kind === targetKind);
        const unknown = isRetry ? [] : all.filter(item => item.kind === 'other');
        const queue = isRetry ? [...retryQueue] : [...knownTarget, ...unknown];
    
        if (!isRetry && !all.length) {
            setStatus('No Bunkr files found on this album page.');
            return;
        }
    
        if (!queue.length) {
            setStatus(`No ${targetKind === 'video' ? 'videos' : 'images'} found.`);
            return;
        }
    
        setStatus(isRetry ? 'Choose the folder for the failed-file retry…' : 'Choose the folder where this batch should be saved…');
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
            consecutiveFailures: 0,
            lastError: '',
            abortReason: '',
        });
    
        state.activeRequests.clear();
        renderFailures();
        setButtonsRunning(true);
        updateProgress();
        setStatus(isRetry ? `Retrying ${queue.length} failed ${targetKind === 'video' ? 'video(s)' : 'image(s)'} in “${directoryHandle.name}”…` : `Saving ${targetKind === 'video' ? 'videos' : 'images'} to “${directoryHandle.name}”…`);
    
        let cursor = 0;
    
        async function worker() {
            while (!state.cancelled) {
                const index = cursor++;
                if (index >= queue.length) return;
                const item = queue[index];
    
                try {
                    const result = await downloadOne(item, targetKind);
                    state.consecutiveFailures = 0;
                    state.lastError = '';
                    if (result.skipped) state.skipped++;
                    else state.downloaded++;
                } catch (error) {
                    if (!state.cancelled) {
                        state.failed++;
                        state.consecutiveFailures++;
                        state.lastError = errorText(error);
                        const failedName = error?.downloadName || item.name || item.slug || 'Unknown file';
                        state.failures.push({
                            name: failedName,
                            error: state.lastError,
                            pageUrl: item.pageUrl,
                            itemData: { ...item },
                        });
                        renderFailures();
                        console.warn('[Bunkr Batch Downloader]', failedName, error);

                        if (state.consecutiveFailures >= CONFIG.maxConsecutiveFailures) {
                            state.abortReason =
                                `Stopped automatically after ${CONFIG.maxConsecutiveFailures} consecutive failures. Last error: ${state.lastError}`;
                            state.cancelled = true;
                            for (const request of [...state.activeRequests]) {
                                try { request.abort(); } catch {}
                            }
                        }
                    }
                } finally {
                    state.finished++;
                    updateProgress();
                }
    
                await sleep(CONFIG.betweenItemsMs);
            }
        }
    
        await Promise.all(Array.from({ length: Math.min(CONFIG.concurrency, queue.length) }, worker));
    
        state.running = false;
        setButtonsRunning(false);
        renderFailures();
    
        if (state.cancelled) {
            setStatus(
                state.abortReason
                    ? `${state.abortReason} ${state.downloaded} file(s) were saved before stopping.`
                    : `Cancelled — ${state.downloaded} downloaded before stopping.`
            );
            return;
        }
    
        const kindLabel = targetKind === 'video' ? 'videos' : 'images';
        const parts = [`Done — ${state.downloaded} ${kindLabel} downloaded`];
        if (state.failed) parts.push(`${state.failed} failed`);
        if (state.skipped) parts.push(`${state.skipped} non-${targetKind} skipped`);
        setStatus(parts.join(', ') + '.');
    
        if (state.failures.length) {
            console.table(state.failures.map(f => ({
                name: f.name,
                error: f.error,
                pageUrl: f.pageUrl,
            })));
        }
    
        refreshCounts();
    }

    function cancelBatch() {
        if (!state.running) return;
        state.cancelled = true;
        state.abortReason = '';
        setStatus('Stopping current download(s)…');
        for (const request of [...state.activeRequests]) {
            try { request.abort(); } catch {}
        }
        const stop = document.getElementById('cbk-stop');
        if (stop) stop.disabled = true;
    }

    function renderFailures() {
        const wrap = document.getElementById('cbk-failures');
        const list = document.getElementById('cbk-failure-list');
        const retry = document.getElementById('cbk-retry-failed');
        const copy = document.getElementById('cbk-copy-failed');
        if (!wrap || !list || !retry || !copy) return;

        const failures = state.failures || [];
        if (!failures.length) {
            wrap.style.display = 'none';
            list.replaceChildren();
            retry.style.display = 'none';
            copy.style.display = 'none';
            return;
        }

        wrap.style.display = 'block';
        list.replaceChildren();

        failures.forEach((failure, index) => {
            const row = document.createElement('div');
            row.className = 'cbk-failure-row';

            const top = document.createElement('div');
            top.className = 'cbk-failure-top';

            const number = document.createElement('span');
            number.className = 'cbk-failure-number';
            number.textContent = `${index + 1}.`;

            const link = document.createElement('a');
            link.className = 'cbk-failure-link';
            link.textContent = failure.name || 'Unknown file';
            link.href = failure.pageUrl || '#';
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.title = 'Open this Bunkr file page';

            top.append(number, link);

            const reason = document.createElement('div');
            reason.className = 'cbk-failure-error';
            reason.textContent = failure.error || 'Download failed';

            row.append(top, reason);
            list.appendChild(row);
        });

        retry.textContent = `Retry Failed Only (${failures.length})`;
        retry.style.display = state.running ? 'none' : 'block';
        copy.style.display = state.running ? 'none' : 'block';
    }

    async function retryFailedOnly() {
        if (state.running || !state.failures.length) return;

        const queue = state.failures
            .map(f => f.itemData)
            .filter(item => item?.pageUrl);

        if (!queue.length) {
            setStatus('The failed-file list no longer has enough information to retry.');
            return;
        }

        const targetKind = state.targetKind || kindFrom(state.failures[0]?.name);
        if (targetKind !== 'video' && targetKind !== 'image') {
            setStatus('Could not determine whether the failed files are videos or images.');
            return;
        }

        await runBatch(targetKind, queue);
    }

    async function copyFailedNames() {
        if (!state.failures.length) return;

        const text = state.failures
            .map((f, i) => `${i + 1}. ${f.name}${f.pageUrl ? `\n   ${f.pageUrl}` : ''}`)
            .join('\n');

        try {
            await navigator.clipboard.writeText(text);
            setStatus(`Copied ${state.failures.length} failed file name(s) and links.`);
        } catch {
            const area = document.createElement('textarea');
            area.value = text;
            area.style.position = 'fixed';
            area.style.opacity = '0';
            document.body.appendChild(area);
            area.select();
            document.execCommand('copy');
            area.remove();
            setStatus(`Copied ${state.failures.length} failed file name(s) and links.`);
        }
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
                ? `${state.finished}/${state.total} processed • ${state.downloaded} downloaded • ${state.failed} failed` +
                  (state.consecutiveFailures ? ` • ${state.consecutiveFailures} consecutive failures` : '')
                : '';
        }
    }

    function setButtonsRunning(running) {
        const video = document.getElementById('cbk-videos');
        const image = document.getElementById('cbk-images');
        const stop = document.getElementById('cbk-stop');
        const retry = document.getElementById('cbk-retry-failed');
        const copy = document.getElementById('cbk-copy-failed');
        if (video) video.disabled = running;
        if (image) image.disabled = running;
        if (stop) {
            stop.disabled = !running;
            stop.style.display = running ? 'block' : 'none';
        }
        if (retry) retry.style.display = !running && state.failures.length ? 'block' : 'none';
        if (copy) copy.style.display = !running && state.failures.length ? 'block' : 'none';
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
            #cbk-retry-failed { background: #d97706; display: none; }
            #cbk-copy-failed { background: #374151; display: none; }
            #cbk-failures {
                display: none;
                margin-top: 10px;
                padding-top: 9px;
                border-top: 1px solid rgba(255,255,255,.10);
            }
            #cbk-failure-heading {
                font-size: 11px;
                font-weight: 700;
                color: #fca5a5;
                margin-bottom: 5px;
            }
            #cbk-failure-list {
                max-height: 180px;
                overflow-y: auto;
                padding-right: 4px;
            }
            .cbk-failure-row {
                padding: 6px 0;
                border-bottom: 1px solid rgba(255,255,255,.07);
            }
            .cbk-failure-top {
                display: flex;
                gap: 5px;
                align-items: flex-start;
                font-size: 11px;
            }
            .cbk-failure-number { color: #fca5a5; flex: 0 0 auto; }
            .cbk-failure-link {
                color: #f5f5f5;
                text-decoration: underline;
                overflow-wrap: anywhere;
            }
            .cbk-failure-error {
                margin: 3px 0 0 17px;
                color: #a8a8ad;
                font-size: 10px;
                line-height: 1.3;
                overflow-wrap: anywhere;
            }
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
            <div id="cbk-title">Bunkr Batch Downloader v1.3.0</div>
            <div id="cbk-counts">Scanning album…</div>
            <button class="cbk-button" id="cbk-videos">Download All Videos</button>
            <button class="cbk-button" id="cbk-images">Download All Images</button>
            <button class="cbk-button" id="cbk-stop">Stop</button>
            <button class="cbk-button" id="cbk-retry-failed">Retry Failed Only</button>
            <button class="cbk-button" id="cbk-copy-failed">Copy Failed List</button>
            <div id="cbk-track"><div id="cbk-progress"></div></div>
            <div id="cbk-progress-label"></div>
            <div id="cbk-status">Ready. Click a batch button, then choose its destination folder once.</div>
            <div id="cbk-failures">
                <div id="cbk-failure-heading">Failed files</div>
                <div id="cbk-failure-list"></div>
            </div>
        `;
        document.body.appendChild(panel);

        document.getElementById('cbk-videos').addEventListener('click', () => runBatch('video'));
        document.getElementById('cbk-images').addEventListener('click', () => runBatch('image'));
        document.getElementById('cbk-stop').addEventListener('click', cancelBatch);
        document.getElementById('cbk-retry-failed').addEventListener('click', retryFailedOnly);
        document.getElementById('cbk-copy-failed').addEventListener('click', copyFailedNames);

        renderFailures();
        refreshCounts();
        setTimeout(refreshCounts, 1200);
        setTimeout(refreshCounts, 3000);
    }

    injectUi();
})();