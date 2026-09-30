import React, { useState, useEffect, useRef } from 'react';
import {
    Folder, Book, Trash2, Edit2, Mail, Download, Upload, Plus,
    CheckSquare, Square, X, Archive, FileText, Check, AlertCircle,
    Copy, ExternalLink, RefreshCw, FolderOpen, MoreVertical, Menu,
    ChevronDown, ChevronUp, Clock, History, Trash, Printer, FileSpreadsheet,
    Sun, Moon, Sparkles, Coffee, AlertTriangle, CheckCircle2, Cloud, CloudOff
} from 'lucide-react';
import { getSyncHandle, setSyncHandle, clearSyncHandle, putAutoBackup } from './syncStorage.js';

// --- Utility Functions ---
const generateId = () => crypto.randomUUID();

const formatDate = (dateString) => {
    if (!dateString) return '';
    const d = new Date(dateString);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

// --- Web Crypto Encryption Utilities (App-Key Casual Privacy) ---
const EXPORT_KEY = "BatchEmailer export key v1 - casual privacy only";
const EXPORT_MARKER = "batch-emailer-encrypted-v1";

function encodeExportBytes(bytes) {
    let binary = "";
    const len = bytes.byteLength;
    const chunkSize = 8192;
    for (let i = 0; i < len; i += chunkSize) {
        const chunk = bytes.subarray(i, Math.min(i + chunkSize, len));
        binary += String.fromCharCode.apply(null, chunk);
    }
    return btoa(binary);
}

function decodeExportBytes(value) {
    const cleanB64 = (value || "").replace(/\s+/g, "");
    const binary = atob(cleanB64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

async function getCryptoKey(usage) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(EXPORT_KEY));
    return crypto.subtle.importKey("raw", digest, "AES-GCM", false, [usage]);
}

async function encryptExport(data) {
    const key = await getCryptoKey("encrypt");
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(data));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
    return JSON.stringify({
        format: EXPORT_MARKER,
        iv: encodeExportBytes(iv),
        data: encodeExportBytes(new Uint8Array(ciphertext))
    }, null, 2);
}

async function parseExport(text) {
    if (typeof text !== "string") return text;
    text = text.replace(/^\uFEFF/, "").trim();
    let envelope;
    try {
        envelope = JSON.parse(text);
    } catch {
        throw new Error("Invalid JSON file");
    }
    if (!envelope || envelope.format !== EXPORT_MARKER) {
        // Legacy plain JSON or raw data
        return envelope;
    }
    const key = await getCryptoKey("decrypt");
    const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: decodeExportBytes(envelope.iv) },
        key,
        decodeExportBytes(envelope.data)
    );
    return JSON.parse(new TextDecoder().decode(plaintext));
}

// --- Canonical Data Representation & Fast Hashing ---
function getCanonicalData(folders = null, classes = null, students = null) {
    let rawFolders, rawClasses, rawStudents;
    if (folders && typeof folders === 'object' && !Array.isArray(folders)) {
        rawFolders = folders.folders || [];
        rawClasses = folders.classes || [];
        rawStudents = folders.students || [];
    } else {
        rawFolders = folders || [];
        rawClasses = classes || [];
        rawStudents = students || [];
    }

    const cleanFolders = [...rawFolders].sort((a, b) => (a.id || '').localeCompare(b.id || '')).map(f => ({
        id: f.id,
        name: f.name || '',
        isArchived: !!f.isArchived,
        createdAt: f.createdAt || ''
    }));

    const cleanClasses = [...rawClasses].sort((a, b) => (a.id || '').localeCompare(b.id || '')).map(c => ({
        id: c.id,
        name: c.name || '',
        folderId: c.folderId || null,
        isArchived: !!c.isArchived,
        createdAt: c.createdAt || ''
    }));

    const cleanStudents = [...rawStudents].sort((a, b) => (a.id || '').localeCompare(b.id || '')).map(s => ({
        id: s.id,
        name: s.name || '',
        classId: s.classId || null,
        emails: [...(s.emails || [])].sort(),
        notes: s.notes || '',
        emailHistory: [...(s.emailHistory || [])].sort((a, b) => (a.id || '').localeCompare(b.id || ''))
    }));

    return { folders: cleanFolders, classes: cleanClasses, students: cleanStudents };
}

function normalizeImportedData(importedData) {
    if (!importedData || typeof importedData !== 'object') {
        throw new Error("Invalid file content");
    }
    const folders = Array.isArray(importedData.folders) ? importedData.folders : [];
    const classes = Array.isArray(importedData.classes) ? importedData.classes : [];
    let students = Array.isArray(importedData.students) ? importedData.students : [];

    // Schema migration for imported datasets
    students = students.map(student => {
        let updatedStudent = { ...student };

        if (!updatedStudent.emails) {
            const emails = [];
            if (updatedStudent.email1 && updatedStudent.email1.trim()) emails.push(updatedStudent.email1.trim());
            if (updatedStudent.email2 && updatedStudent.email2.trim()) emails.push(updatedStudent.email2.trim());
            if (emails.length === 0) emails.push('');
            updatedStudent.emails = emails;
        }

        if (!updatedStudent.emailHistory) {
            const history = [];
            if (updatedStudent.message || updatedStudent.timestamp) {
                history.push({
                    id: legacyHistoryLogId(updatedStudent.id, updatedStudent.timestamp, updatedStudent.message),
                    timestamp: updatedStudent.timestamp || '',
                    message: updatedStudent.message || ''
                });
            }
            updatedStudent.emailHistory = history;
        }
        return updatedStudent;
    });

    return { folders, classes, students };
}

// Deterministic id for log entries synthesized from a contact's legacy
// top-level message/timestamp fields. Random ids here would make normalizing
// the same file twice produce different content hashes — which sync would read
// as two different datasets — and would break backup verification.
function legacyHistoryLogId(studentId, timestamp, message) {
    const stamp = String(timestamp || '').replace(/[^0-9]/g, '');
    return `log_${studentId || 'unknown'}_${stamp || '0'}_${String(message || '').length}`;
}

// --- Backup Completeness Helpers ---
// Everything the user can type or set up lives in `data` (folders, groups,
// contacts, notes, email logs) plus these extra localStorage preferences that
// are deliberately NOT part of `data`:
//   - theme (a user preference, restorable from a backup)
// Device/sync bookkeeping (device id, sync meta, file handles) is device
// specific and must never travel inside a backup.
const SETTINGS_KEYS = { theme: 'batch-emailer-theme' };

function readBackupSettings(source = null) {
    let theme;
    try {
        theme = source && source.settings && typeof source.settings === 'object'
            ? source.settings.theme
            : localStorage.getItem(SETTINGS_KEYS.theme);
    } catch {
        theme = null;
    }
    return { theme: theme === 'light' ? 'light' : 'dark' };
}

function countEmailMessages(source) {
    const students = (source && source.students) || [];
    return students.reduce((total, s) => {
        if (!s) return total;
        // Counts the stored log entries; falls back to the legacy top-level
        // message for never-migrated contacts without double counting.
        if (Array.isArray(s.emailHistory)) {
            return total + (s.emailHistory.length || (s.message ? 1 : 0));
        }
        return total + (s.message || s.timestamp ? 1 : 0);
    }, 0);
}

// Folder/group/contact/message counts — shown to the user and used to prove a
// written backup file contains the same amount of data as the app.
function getDataSummary(source) {
    const src = source || {};
    return {
        folderCount: (src.folders || []).length,
        classCount: (src.classes || []).length,
        studentCount: (src.students || []).length,
        messageCount: countEmailMessages(src)
    };
}

function describeDataSummary(source) {
    const s = getDataSummary(source);
    return `${s.folderCount} folder${s.folderCount === 1 ? '' : 's'}, ` +
        `${s.classCount} group${s.classCount === 1 ? '' : 's'}, ` +
        `${s.studentCount} contact${s.studentCount === 1 ? '' : 's'} and ` +
        `${s.messageCount} email message${s.messageCount === 1 ? '' : 's'}`;
}

// Merges a contact from a backup into an existing local contact with the same
// id. Local values win, empty local values are filled in from the file, and the
// email histories are unioned (de-duplicated, newest first) so an import can
// never silently discard messages that only exist in the file.
function mergeContactRecords(local, incoming) {
    const localHistory = Array.isArray(local.emailHistory) ? local.emailHistory : [];
    const incomingHistory = Array.isArray(incoming.emailHistory) ? incoming.emailHistory : [];

    const seen = new Set();
    const mergedHistory = [];
    [...localHistory, ...incomingHistory].forEach(log => {
        if (!log || typeof log !== 'object') return;
        const key = log.id || `${log.timestamp || ''}|${log.message || ''}|${log.subject || ''}`;
        if (seen.has(key)) return;
        seen.add(key);
        mergedHistory.push(log);
    });
    mergedHistory.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));

    const newest = mergedHistory[0] || null;
    const emails = [...(local.emails || [])];
    (incoming.emails || []).forEach(email => {
        if (email && !emails.includes(email)) emails.push(email);
    });

    return {
        ...incoming,
        ...local,
        name: local.name || incoming.name || '',
        notes: local.notes || incoming.notes || '',
        classId: local.classId || incoming.classId || null,
        emails: emails.length > 0 ? emails : [''],
        emailHistory: mergedHistory,
        timestamp: newest ? (newest.timestamp || '') : (local.timestamp || ''),
        message: newest ? (newest.message || '') : (local.message || '')
    };
}

// Builds the exact file body shared by backups, sync writes and auto-pushes.
// Everything the app stores travels in here, unmodified.
async function buildBackupPayload(activeData, revision) {
    const canonicalData = getCanonicalData(activeData);
    const contentHash = await computeDataHash(canonicalData);
    return {
        version: 2,
        exportedAt: new Date().toISOString(),
        syncMeta: {
            schemaVersion: 2,
            revision: revision,
            timestamp: Date.now(),
            deviceId: getDeviceId(),
            deviceName: getDeviceName(),
            contentHash: contentHash,
            summary: getDataSummary(activeData)
        },
        // Raw objects, untouched: every field the app stores travels into the
        // file — including each contact's full emailHistory (the messages).
        folders: activeData.folders || [],
        classes: activeData.classes || [],
        students: activeData.students || [],
        // Settings are carried in the file (restored explicitly via
        // "Replace All Data") but are deliberately kept out of the content
        // hash so a theme change alone can never trigger a sync conflict.
        settings: readBackupSettings()
    };
}

// Exported for scripts/verify_backup_integrity.mjs so the backup path can be
// proven round-trip safe without booting the whole app.
export {
    encryptExport, parseExport, getCanonicalData, normalizeImportedData,
    buildBackupPayload, verifyBackupRoundTrip, getDataSummary,
    describeDataSummary, countEmailMessages, mergeContactRecords, readBackupSettings,
    parseContactsFromText, buildContactRecords, parseCSV,
    IMPORT_EXAMPLE_PASTE, IMPORT_EXAMPLE_CSV
};

// Decrypts a file we just wrote and proves it still holds every folder, group,
// contact and email message before we let the write succeed. Fails loudly
// instead of silently producing an incomplete backup/sync file.
async function verifyBackupRoundTrip(jsonStr, sourceData, sourceSettings) {
    let roundTrip;
    try {
        roundTrip = await parseExport(jsonStr);
    } catch (err) {
        throw new Error("Backup verification failed — the written file could not be read back (" + (err.message || err) + ").");
    }
    if (!roundTrip || typeof roundTrip !== 'object') {
        throw new Error("Backup verification failed — the written file could not be read back.");
    }

    const expected = getDataSummary(sourceData);
    const actual = getDataSummary(roundTrip);
    const mismatches = Object.keys(expected).filter(key => expected[key] !== actual[key]);
    if (mismatches.length > 0) {
        throw new Error("Backup verification failed — " + mismatches
            .map(key => `${key}: ${expected[key]} in your data vs ${actual[key]} in the file`)
            .join(", ") + ".");
    }

    const sourceCanonical = await computeDataHash(getCanonicalData(normalizeImportedData(sourceData)));
    const fileCanonical = await computeDataHash(getCanonicalData(normalizeImportedData(roundTrip)));
    if (sourceCanonical !== fileCanonical) {
        throw new Error("Backup verification failed — the contents of the written file differ from your data.");
    }

    // This is a file we just wrote, so the settings block must be in it — no
    // falling back to the live browser preferences the way legacy files do.
    if (!roundTrip.settings || typeof roundTrip.settings !== 'object') {
        throw new Error("Backup verification failed — your settings were missing from the file.");
    }
    if (JSON.stringify(readBackupSettings(roundTrip)) !== JSON.stringify(sourceSettings || readBackupSettings())) {
        throw new Error("Backup verification failed — your settings were not preserved in the file.");
    }

    return actual;
}

function computeDataHashSync(canonicalData) {
    const str = JSON.stringify(canonicalData);
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash) + str.charCodeAt(i);
        hash |= 0;
    }
    return hash.toString(16);
}

async function computeDataHash(canonicalData) {
    const str = JSON.stringify(canonicalData);
    const buffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function getDeviceId() {
    let id = localStorage.getItem('batch-emailer-device-id');
    if (!id) {
        id = (typeof crypto.randomUUID === 'function')
            ? crypto.randomUUID()
            : ('dev-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9));
        localStorage.setItem('batch-emailer-device-id', id);
    }
    return id;
}

function getDeviceName() {
    const ua = navigator.userAgent;
    if (/iPhone/i.test(ua)) return "iPhone";
    if (/iPad/i.test(ua)) return "iPad";
    if (/Macintosh|Mac OS X/i.test(ua)) {
        return screen.width >= 2560 ? "iMac / Mac" : "MacBook";
    }
    if (/Windows/i.test(ua)) return "PC";
    if (/Android/i.test(ua)) return "Android";
    if (/Linux/i.test(ua)) return "Linux";
    return "Browser";
}

const SYNC_META_KEY = 'batch-emailer-sync-meta';

function getSyncMeta() {
    try {
        const raw = localStorage.getItem(SYNC_META_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch {
        return {};
    }
}

function setSyncMeta(updates) {
    try {
        const current = getSyncMeta();
        const next = { ...current, ...updates };
        localStorage.setItem(SYNC_META_KEY, JSON.stringify(next));
        return next;
    } catch {
        return {};
    }
}

function syncNeedsPush(currentData = null) {
    const meta = getSyncMeta();
    if (!meta.fileName) return false;
    if ((meta.lastLocalChange || 0) > (meta.lastSyncedAt || 0)) {
        return true;
    }
    if (currentData && meta.baseFastHash) {
        const currentFastHash = computeDataHashSync(getCanonicalData(currentData));
        if (currentFastHash !== meta.baseFastHash) {
            return true;
        }
    }
    return false;
}

// Turn low-level failures (mostly IndexedDB DOMExceptions) into something the
// user can act on instead of a truncated browser message.
function describeSyncError(error) {
    const message = (error && error.message) || String(error);
    if (message.includes("IDBDatabase") || message.includes("object store") || (error && error.name === "VersionError")) {
        return "the app's browser storage is out of date — reload the app and try again. If that keeps happening, clear this site's data and import your backup once more.";
    }
    if (error && error.name === "AbortError") {
        return "the operation was cancelled.";
    }
    return message;
}

// --- Fingerprinting & Difference Engine ---
function generateDataFingerprint(dataObj = null) {
    const f = dataObj ? (dataObj.folders || []) : [];
    const c = dataObj ? (dataObj.classes || []) : [];
    const s = dataObj ? (dataObj.students || []) : [];

    const classSummary = c.map(item => ({
        id: item.id,
        name: item.name || "Untitled Group",
        folderId: item.folderId,
        contactCount: s.filter(st => st.classId === item.id).length
    }));

    return {
        timestamp: dataObj?.exportedAt ? new Date(dataObj.exportedAt).getTime() : (dataObj?.syncMeta?.timestamp || Date.now()),
        folderCount: f.length,
        classCount: c.length,
        studentCount: s.length,
        classes: classSummary,
        totalContacts: s.length
    };
}

function compareFingerprints(localFP, fileFP) {
    if (!localFP || !fileFP) return null;
    const differences = [];

    const localMap = new Map((localFP.classes || []).map(t => [t.id, t]));
    const fileMap = new Map((fileFP.classes || []).map(t => [t.id, t]));

    // New in file
    const newInFile = (fileFP.classes || []).filter(t => !localMap.has(t.id));
    if (newInFile.length > 0) {
        differences.push({
            type: "newClasses",
            description: `New group(s) in file: ${newInFile.map(t => t.name).join(", ")}`,
            items: newInFile
        });
    }

    // Removed from file (only in local)
    const onlyInLocal = (localFP.classes || []).filter(t => !fileMap.has(t.id));
    if (onlyInLocal.length > 0) {
        differences.push({
            type: "removedClasses",
            description: `Group(s) only in local data: ${onlyInLocal.map(t => t.name).join(", ")}`,
            items: onlyInLocal
        });
    }

    // Modified groups
    const modified = [];
    (localFP.classes || []).forEach(localItem => {
        const fileItem = fileMap.get(localItem.id);
        if (fileItem) {
            const changes = [];
            if (localItem.name !== fileItem.name) changes.push(`Name changed: "${localItem.name}" vs "${fileItem.name}"`);
            if (localItem.contactCount !== fileItem.contactCount) changes.push(`Contacts: ${localItem.contactCount} (local) vs ${fileItem.contactCount} (file)`);
            if (changes.length > 0) {
                modified.push({ name: localItem.name, changes });
            }
        }
    });

    if (modified.length > 0) {
        differences.push({
            type: "modifiedClasses",
            description: `${modified.length} group(s) modified`,
            items: modified
        });
    }

    if (localFP.folderCount !== fileFP.folderCount) {
        differences.push({
            type: "folderCount",
            description: `Folders count differs: ${localFP.folderCount} local vs ${fileFP.folderCount} in file`,
            items: []
        });
    }

    if (localFP.studentCount !== fileFP.studentCount) {
        differences.push({
            type: "contactCount",
            description: `Contacts count differs: ${localFP.studentCount} local vs ${fileFP.studentCount} in file`,
            items: []
        });
    }

    return { differences, hasDifferences: differences.length > 0 };
}

// --- IndexedDB Sync Handle & Auto-Backup Storage ---
// Opening the database, migrating older store layouts and reading/writing the
// stored file handle all live in ./syncStorage.js.
const saveAutoBackupToIDB = async (dataToSave) => {
    try {
        const encrypted = await encryptExport(dataToSave);
        await putAutoBackup({
            id: 'latest_auto_backup',
            timestamp: new Date().toISOString(),
            envelope: JSON.parse(encrypted)
        });
    } catch (err) {
        console.warn("Failed to write auto-backup to IndexedDB:", err);
    }
};

// --- Save File Helper with File System Access API & Fallback ---
// Returns the FileSystemFileHandle on success, 'downloaded' when the browser
// fell back to a regular download, or 'cancelled' if the user aborted the
// save dialog — so callers never report a backup that was never written.
async function saveFileAs(content, defaultFilename, mimeType = "application/json") {
    if (window.showSaveFilePicker) {
        try {
            const ext = defaultFilename.split(".").pop();
            const handle = await window.showSaveFilePicker({
                suggestedName: defaultFilename,
                types: [{ description: "JSON File", accept: { [mimeType]: ["." + ext] } }]
            });
            const writable = await handle.createWritable();
            await writable.write(typeof content === "string" ? content : JSON.stringify(content));
            await writable.close();
            return handle;
        } catch (e) {
            if (e.name === "AbortError") return 'cancelled';
        }
    }
    // Fallback (Firefox, Safari, mobile)
    const str = typeof content === "string" ? content : JSON.stringify(content);
    const blob = new Blob([str], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = defaultFilename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return 'downloaded';
}

// ---- File System Access Helpers (Chrome/Edge/Arc) ----
async function pickSyncFile() {
    if (window.showOpenFilePicker) {
        try {
            const [handle] = await window.showOpenFilePicker({
                types: [{ description: "JSON File", accept: { "application/json": [".json"] } }],
                excludeAcceptAllOption: true
            });
            return handle;
        } catch (e) {
            if (e.name === "AbortError") return null;
            throw e;
        }
    }

    if (window.showSaveFilePicker) {
        try {
            return await window.showSaveFilePicker({
                suggestedName: "batch_emailer_sync.json",
                types: [{ description: "JSON File", accept: { "application/json": [".json"] } }]
            });
        } catch (e) {
            if (e.name === "AbortError") return null;
            throw e;
        }
    }
    return null;
}

async function readSyncFile(handle) {
    const file = await handle.getFile();
    const text = await file.text();
    let parsed = null;
    let fileHasData = false;
    const fileHasContent = !!(text && text.trim());
    if (fileHasContent) {
        try {
            parsed = await parseExport(text);
            fileHasData = parsed && parsed.version === 2 && (Array.isArray(parsed.folders) || Array.isArray(parsed.classes) || Array.isArray(parsed.students));
        } catch {
            fileHasData = false;
        }
    }
    return { file, fileLastModified: file.lastModified || 0, parsed, fileHasData, fileHasContent };
}

// --- Local CSV Parser Utility ---
const parseCSV = (text) => {
    const lines = [];
    let row = [""];
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        const nextChar = text[i + 1];
        if (char === '"') {
            if (inQuotes && nextChar === '"') {
                row[row.length - 1] += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (char === ',' && !inQuotes) {
            row.push('');
        } else if ((char === '\r' || char === '\n') && !inQuotes) {
            if (char === '\r' && nextChar === '\n') {
                i++;
            }
            lines.push(row);
            row = [""];
        } else {
            row[row.length - 1] += char;
        }
    }
    if (row.length > 1 || row[0] !== '') {
        lines.push(row);
    }
    return lines;
};

// --- Flexible Contact Parser ------------------------------------------------
// Accepts anything a person might paste: Google Docs/Sheets tables (tab
// separated rows), comma separated rows, one value per line, "Name <email>",
// a name line followed by its email line(s), several emails in one cell,
// header rows, blank lines and stray CRLF characters.
const CONTACT_EMAIL_RE = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

const CONTACT_HEADER_WORDS = new Set([
    'name', 'names', 'full name', 'contact', 'contact name', 'student', 'student name',
    'first name', 'last name', 'email', 'emails', 'e-mail', 'e-mails',
    'email address', 'email addresses', 'e-mail address', 'e-mail addresses',
    'address', 'phone', 'phone number', 'mobile', 'notes', 'note', 'comments',
    'comment', 'title', 'role'
]);

function isContactHeaderRow(cells) {
    if (!cells || cells.length === 0) return false;
    const normalized = cells.map(c => String(c).trim().toLowerCase());
    if (normalized.every(c => CONTACT_HEADER_WORDS.has(c))) return true;
    const joined = normalized.join(' ');
    return /^(name|full name|first name|last name|student name|contact name)[\s,&/+-]+(e-?mail|emails|address)/.test(joined)
        || /^e-?mail(s)?[\s,&/+-]+(name|contact)/.test(joined);
}

function splitContactLine(line) {
    if (line.includes('\t')) return line.split('\t');
    if (line.includes(',')) return line.split(',');
    return [line];
}

function makeContactRecord(name, emails, notes) {
    return {
        name: String(name || '')
            .replace(/^(?:name|contact|student|full name|e-?mail)\s*[:\-–]\s*/i, '')
            .trim(),
        emails: (emails || []).filter(Boolean),
        notes: String(notes || '').trim()
    };
}

// rows: array of arrays of raw cell strings (already split on tabs/commas).
function buildContactRecords(rows) {
    const records = [];
    // The most recent name-only row, which following email-only rows belong to
    // ("name line" / "email line" / "email line" pastes).
    let pendingName = null;

    (rows || []).forEach(rawCells => {
        const cells = (rawCells || [])
            .map(c => String(c ?? '').replace(/\u00A0/g, ' ').trim())
            .filter(c => c !== '');
        if (cells.length === 0) return;
        if (isContactHeaderRow(cells)) return;

        const emails = [];
        const texts = [];
        cells.forEach(cell => {
            const found = cell.match(CONTACT_EMAIL_RE) || [];
            found.forEach(addr => {
                const value = addr.trim();
                if (value && !emails.includes(value)) emails.push(value);
            });
            const rest = cell
                .replace(CONTACT_EMAIL_RE, ' ')
                .replace(/^[\s,;:<>()\[\]"']+/, '')
                .replace(/[\s,;:<>()\[\]"']+$/, '')
                .trim();
            if (rest) texts.push(rest);
        });

        if (emails.length > 0 && texts.length > 0) {
            // "Name  email  note" on one row
            const record = makeContactRecord(texts[0], emails, texts.slice(1).join(' '));
            records.push(record);
            pendingName = null;
        } else if (emails.length > 0) {
            // An email-only row belongs to the name above it; if there is no
            // name to attach to, keep it as a nameless row the user can fix.
            if (pendingName) {
                emails.forEach(addr => {
                    if (!pendingName.emails.includes(addr)) pendingName.emails.push(addr);
                });
            } else {
                records.push(makeContactRecord('', emails, ''));
            }
        } else {
            // Text-only row: a name (the preview lets the user fix it up).
            const record = makeContactRecord(cells.join(' '), [], '');
            records.push(record);
            pendingName = record;
        }
    });

    return records.filter(r => r.name !== '' || r.emails.length > 0);
}

function parseContactsFromText(text) {
    const normalized = String(text ?? '')
        .replace(/\r\n?/g, '\n')
        .replace(/\u00A0/g, ' ');
    // Text copied out of "Save as CSV" keeps its quotes and needs the strict
    // CSV reader; everything else goes through the loose line reader.
    if (normalized.includes('"') && normalized.includes(',')) {
        const csvRows = parseCSV(normalized);
        if (csvRows.some(row => row.length > 1)) return buildContactRecords(csvRows);
    }
    return buildContactRecords(normalized.split('\n').map(splitContactLine));
}

// --- Generic, Robust Custom Local Storage Hook ---
// `onStorageError` (optional) is called if the browser refuses the write —
// without it a full disk silently throws data (including email messages) away.
function useLocalStorage(key, initialValue, onStorageError) {
    const [storedValue, setStoredValue] = useState(() => {
        try {
            const item = window.localStorage.getItem(key);
            if (!item) return initialValue;
            try {
                return JSON.parse(item);
            } catch (e) {
                // Fallback in case of raw unquoted string values
                return item;
            }
        } catch (error) {
            console.warn(error);
            return initialValue;
        }
    });

    // Keep the latest handler in a ref so the save effect stays stable.
    const errorHandlerRef = useRef(null);
    useEffect(() => {
        errorHandlerRef.current = onStorageError || null;
    });

    useEffect(() => {
        try {
            window.localStorage.setItem(key, JSON.stringify(storedValue));
        } catch (error) {
            console.error(`[Storage] Could not save "${key}":`, error);
            if (errorHandlerRef.current) errorHandlerRef.current(error);
        }
    }, [key, storedValue]);

    return [storedValue, setStoredValue];
}

// --- Main Application Component ---
export default function App() {
    // State
    // Set when the browser refuses to persist data (almost always "storage
    // full"). Declared first so the storage hooks below can report into it.
    const [storageError, setStorageError] = useState(null);

    const [data, setData] = useLocalStorage('batch-emailer-data', {
        folders: [],
        classes: [], // Internally classes, represented as "Groups" in UI
        students: [] // Internally students, represented as "Contacts" in UI
    }, setStorageError);

    const [activeFolderId, setActiveFolderId] = useState(null);
    const [activeClassId, setActiveClassId] = useState(null);
    const [expandedFolders, setExpandedFolders] = useState({});
    const [showArchived, setShowArchived] = useState(false);
    const [sidebarOpen, setSidebarOpen] = useState(true);
    const [expandedStudents, setExpandedStudents] = useState([]);
    const [expandedEmailContacts, setExpandedEmailContacts] = useState([]);
    const [theme, setTheme] = useLocalStorage('batch-emailer-theme', 'dark', setStorageError); // Defaulting to dark

    // Modals
    const [modals, setModals] = useState({
        folder: false,
        class: false,
        student: false,
        bulkAdd: false, // Unified Import Modal
        draftEmail: false,
        backup: false,
        changelog: false,
        privacy: false
    });

    // Custom Dialog Alert/Confirm State to bypass restricted environment popups
    const [customDialog, setCustomDialog] = useState({
        isOpen: false,
        title: '',
        message: '',
        isConfirm: false,
        onConfirm: null
    });

    // Surface persistence failures loudly: a rejected localStorage write means
    // the latest edits (email messages included) only exist until reload.
    useEffect(() => {
        if (!storageError) return;
        const raw = storageError.message || String(storageError);
        const isQuota = storageError.name === 'QuotaExceededError'
            || storageError.name === 'NS_ERROR_DOM_QUOTA_REACHED'
            || storageError.name === 'QUOTA_EXCEEDED_ERR'
            || /quota|storage|exceed/i.test(raw);
        setCustomDialog({
            isOpen: true,
            title: isQuota ? 'Browser Storage Is Full' : 'Changes Not Saved',
            message: isQuota
                ? "Your browser is out of storage space, so your latest changes (including email messages) were NOT saved and will be lost on reload. Download a backup now to protect your data, then free up space by clearing other sites' data."
                : "Your latest changes could not be saved to browser storage: " + raw,
            isConfirm: false,
            onConfirm: null
        });
        setStorageError(null);
    }, [storageError]);

    // Edit states
    const [editingItem, setEditingItem] = useState(null);
    const [selectedStudents, setSelectedStudents] = useState([]);
    const [lastSelectedStudentId, setLastSelectedStudentId] = useState(null);

    // Right-click context menu for contact rows ({ studentId, x, y } or null)
    const [contextMenu, setContextMenu] = useState(null);

    // Dynamic email inputs state for modal
    const [modalEmails, setModalEmails] = useState(['']);

    // Handle data migration explicitly on component mount/load rather than in the generic hook
    useEffect(() => {
        if (data && data.students) {
            let migrated = false;
            const migratedStudents = data.students.map(student => {
                let updatedStudent = { ...student };
                let studentChanged = false;

                // 1. Migrate email1 & email2 to modern emails array
                if (!updatedStudent.emails) {
                    const emails = [];
                    if (updatedStudent.email1 && updatedStudent.email1.trim()) emails.push(updatedStudent.email1.trim());
                    if (updatedStudent.email2 && updatedStudent.email2.trim()) emails.push(updatedStudent.email2.trim());
                    if (emails.length === 0) emails.push('');
                    updatedStudent.emails = emails;
                    studentChanged = true;
                }

                // 2. Migrate message/timestamp strings to emailHistory arrays
                if (!updatedStudent.emailHistory) {
                    const history = [];
                    if (updatedStudent.message || updatedStudent.timestamp) {
                        history.push({
                            id: legacyHistoryLogId(updatedStudent.id, updatedStudent.timestamp, updatedStudent.message),
                            timestamp: updatedStudent.timestamp || '',
                            message: updatedStudent.message || ''
                        });
                    }
                    updatedStudent.emailHistory = history;
                    updatedStudent.timestamp = updatedStudent.timestamp || '';
                    updatedStudent.message = updatedStudent.message || '';
                    studentChanged = true;
                }

                if (studentChanged) migrated = true;
                return updatedStudent;
            });

            if (migrated) {
                setData(prev => ({ ...prev, students: migratedStudents }));
            }
        }
    }, [data, setData]);

    // Sync & Backup State (Universal Architecture)
    const [syncStatus, setSyncStatus] = useState('idle'); // 'idle' | 'syncing' | 'synced' | 'local-changes' | 'external-update' | 'error'
    const [syncFileName, setSyncFileName] = useState('');
    const [showSyncConflictModal, setShowSyncConflictModal] = useState(false);
    const [syncConflictData, setSyncConflictData] = useState(null);
    const [showRestoreChoiceModal, setShowRestoreChoiceModal] = useState(false);
    const [pendingRestoreData, setPendingRestoreData] = useState(null);
    const [syncToast, setSyncToast] = useState(null);
    const [externalBanner, setExternalBanner] = useState(null);

    const showSyncToast = (message, type = "info") => {
        setSyncToast({ message, type, id: Date.now() });
    };

    useEffect(() => {
        if (!syncToast) return;
        const timer = setTimeout(() => {
            setSyncToast(null);
        }, 4000);
        return () => clearTimeout(timer);
    }, [syncToast]);

    // Check for external updates from other devices (e.g. cloud folder sync)
    const checkForExternalChanges = async () => {
        const hasFSA = !!(window.showSaveFilePicker || window.showOpenFilePicker);
        if (!hasFSA) return;

        const meta = getSyncMeta();
        if (!meta.fileName) return;

        const handle = await getSyncHandle();
        if (!handle) return;

        try {
            const perm = await handle.queryPermission({ mode: "readwrite" });
            if (perm !== "granted") return;

            const file = await handle.getFile();
            if (file.lastModified > (meta.lastSyncedAt || 0)) {
                const text = await file.text();
                const parsed = await parseExport(text);
                if (parsed && (Array.isArray(parsed.folders) || Array.isArray(parsed.classes) || Array.isArray(parsed.students))) {
                    const normalized = normalizeImportedData(parsed);
                    const fileCanonical = getCanonicalData(normalized);
                    const fileHash = await computeDataHash(fileCanonical);
                    if (fileHash && fileHash !== meta.lastSyncedContentHash) {
                        setSyncMeta({
                            externalUpdateAvailable: true,
                            externalUpdateAuthor: parsed.syncMeta?.deviceName || ""
                        });
                        const author = parsed.syncMeta?.deviceName ? ` on ${parsed.syncMeta.deviceName}` : "";
                        setExternalBanner(`"${meta.fileName}" was updated${author} — click Sync Now to pull.`);
                        setSyncStatus('external-update');
                    }
                }
            }
        } catch (e) {
            console.warn("[Sync] external change check:", e);
        }
    };

    const isFirstMount = useRef(true);

    // Automatic Browser Backup to IndexedDB on data changes + change tracking
    useEffect(() => {
        if (isFirstMount.current) {
            isFirstMount.current = false;
            return;
        }
        if (data) {
            const now = Date.now();
            setSyncMeta({ lastLocalChange: now });
            const meta = getSyncMeta();
            if (meta.fileName) {
                setSyncStatus('local-changes');
            }
            if (data.folders.length > 0 || data.classes.length > 0 || data.students.length > 0) {
                saveAutoBackupToIDB(data);
            }
        }
    }, [data]);

    // Initialize Sync Handle and Status on Mount
    useEffect(() => {
        const initSync = async () => {
            try {
                const meta = getSyncMeta();
                let currentFileName = meta.fileName || '';
                const handle = await getSyncHandle();
                if (handle) {
                    currentFileName = handle.name;
                    setSyncMeta({ fileName: handle.name });
                }
                if (currentFileName) {
                    setSyncFileName(currentFileName);
                }

                if (meta.externalUpdateAvailable && currentFileName) {
                    setSyncStatus('external-update');
                    const author = meta.externalUpdateAuthor ? ` on ${meta.externalUpdateAuthor}` : "";
                    setExternalBanner(`"${currentFileName}" was updated${author} — click Sync Now to pull.`);
                } else if (syncNeedsPush(data)) {
                    setSyncStatus('local-changes');
                } else if (currentFileName) {
                    setSyncStatus('synced');
                } else {
                    setSyncStatus('idle');
                }

                if (handle) {
                    checkForExternalChanges();
                }
            } catch (err) {
                console.warn("Failed to initialize sync state:", err);
            }
        };
        initSync();
    }, []);

    // Tab Focus & Visibility Detection + beforeunload warning for unsynced changes
    useEffect(() => {
        const onBeforeUnload = (e) => {
            if (syncNeedsPush(data) && getSyncMeta().fileName) {
                e.preventDefault();
                e.returnValue = "";
            }
        };
        const onVisibilityChange = () => {
            if (document.visibilityState === "visible") {
                checkForExternalChanges();
            }
        };
        const onFocus = () => {
            checkForExternalChanges();
        };

        window.addEventListener("beforeunload", onBeforeUnload);
        document.addEventListener("visibilitychange", onVisibilityChange);
        window.addEventListener("focus", onFocus);

        return () => {
            window.removeEventListener("beforeunload", onBeforeUnload);
            document.removeEventListener("visibilitychange", onVisibilityChange);
            window.removeEventListener("focus", onFocus);
        };
    }, [data]);

    // Handle auto-collapsing sidebar on mount for smaller mobile screens
    useEffect(() => {
        const handleResize = () => {
            if (window.innerWidth < 768) {
                setSidebarOpen(false);
            } else {
                setSidebarOpen(true);
            }
        };
        handleResize(); // run on initial mount
        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, []);

    // Automatically expand parent folder when folder or group becomes active
    useEffect(() => {
        if (activeFolderId) {
            setExpandedFolders(prev => ({ ...prev, [activeFolderId]: true }));
        }
    }, [activeFolderId]);

    useEffect(() => {
        if (activeClassId) {
            const cls = data.classes.find(c => c.id === activeClassId);
            if (cls && cls.folderId) {
                setExpandedFolders(prev => ({ ...prev, [cls.folderId]: true }));
            }
        }
    }, [activeClassId, data.classes]);

    // Data helpers
    const activeFolders = data.folders.filter(f => showArchived ? true : !f.isArchived);
    const activeClasses = data.classes.filter(c =>
        showArchived ? true : !c.isArchived
    );
    const currentClass = data.classes.find(c => c.id === activeClassId);
    const classStudents = data.students.filter(s => s.classId === activeClassId);

    // Helper trigger for custom dialogs
    const showAlert = (title, message) => {
        setCustomDialog({
            isOpen: true,
            title,
            message,
            isConfirm: false,
            onConfirm: null
        });
    };

    const showConfirm = (title, message, callback) => {
        setCustomDialog({
            isOpen: true,
            title,
            message,
            isConfirm: true,
            onConfirm: () => {
                callback();
                setCustomDialog(prev => ({ ...prev, isOpen: false }));
            }
        });
    };

    // Select all logic
    const allSelected = classStudents.length > 0 && selectedStudents.length === classStudents.length;
    const toggleSelectAll = () => {
        if (allSelected) {
            setSelectedStudents([]);
        } else {
            setSelectedStudents(classStudents.map(s => s.id));
        }
    };

    const toggleStudentSelection = (id) => {
        setSelectedStudents(prev =>
            prev.includes(id) ? prev.filter(sId => sId !== id) : [...prev, id]
        );
    };

    const toggleFolder = (folderId) => {
        setExpandedFolders(prev => ({
            ...prev,
            [folderId]: !prev[folderId]
        }));
        setActiveFolderId(folderId);
    };

    const handleStudentClick = (e, studentId) => {
        // Prevent action if clicking on interactive children
        const target = e.target;
        if (
            target.closest('button') ||
            target.closest('a') ||
            target.closest('input') ||
            target.closest('.select-all') ||
            target.closest('svg')
        ) {
            return;
        }

        const orderedIds = classStudents.map(s => s.id);
        const targetIndex = orderedIds.indexOf(studentId);
        const hasModifier = e.ctrlKey || e.metaKey;
        let newSelection = [...selectedStudents];

        if (e.shiftKey && lastSelectedStudentId && orderedIds.includes(lastSelectedStudentId)) {
            const lastIndex = orderedIds.indexOf(lastSelectedStudentId);
            const start = Math.min(lastIndex, targetIndex);
            const end = Math.max(lastIndex, targetIndex);
            const rangeIds = orderedIds.slice(start, end + 1);

            // Shift selects the range; Ctrl/Cmd + Shift appends the range to the selection
            newSelection = hasModifier
                ? Array.from(new Set([...selectedStudents, ...rangeIds]))
                : rangeIds;
        } else if (hasModifier) {
            // Ctrl/Cmd toggles a single contact without disturbing the rest of the selection
            newSelection = selectedStudents.includes(studentId)
                ? selectedStudents.filter(id => id !== studentId)
                : [...selectedStudents, studentId];
            setLastSelectedStudentId(studentId);
        } else {
            // Plain click replaces the selection with just this contact
            newSelection = [studentId];
            setLastSelectedStudentId(studentId);
        }

        setSelectedStudents(newSelection);
    };

    const openContactContextMenu = (e, studentId) => {
        e.preventDefault();
        e.stopPropagation();

        // Right-clicking a contact outside the current selection selects only that contact
        if (!selectedStudents.includes(studentId)) {
            setSelectedStudents([studentId]);
            setLastSelectedStudentId(studentId);
        }

        const MENU_WIDTH = 200;
        const MENU_HEIGHT = 116;
        setContextMenu({
            studentId,
            x: Math.max(8, Math.min(e.clientX, window.innerWidth - MENU_WIDTH - 8)),
            y: Math.max(8, Math.min(e.clientY, window.innerHeight - MENU_HEIGHT - 8))
        });
    };

    const toggleStudentHistory = (studentId) => {
        setExpandedStudents(prev =>
            prev.includes(studentId) ? prev.filter(id => id !== studentId) : [...prev, studentId]
        );
    };

    const toggleEmailsExpanded = (studentId, e) => {
        e.stopPropagation();
        setExpandedEmailContacts(prev =>
            prev.includes(studentId) ? prev.filter(id => id !== studentId) : [...prev, studentId]
        );
    };

    // CRUD Operations
    const saveFolder = (e) => {
        e.preventDefault();
        const name = e.target.name.value;
        if (editingItem) {
            setData(prev => ({
                ...prev,
                folders: prev.folders.map(f => f.id === editingItem.id ? { ...f, name } : f)
            }));
        } else {
            const newFolder = { id: generateId(), name, isArchived: false, createdAt: new Date().toISOString() };
            setData(prev => ({ ...prev, folders: [...prev.folders, newFolder] }));
            setActiveFolderId(newFolder.id);
        }
        closeModals();
    };

    const saveClass = (e) => {
        e.preventDefault();
        const name = e.target.name.value;
        const folderId = e.target.folderId.value;
        if (editingItem) {
            setData(prev => ({
                ...prev,
                classes: prev.classes.map(c => c.id === editingItem.id ? { ...c, name, folderId } : c)
            }));
        } else {
            const newClass = { id: generateId(), folderId, name, isArchived: false, createdAt: new Date().toISOString() };
            setData(prev => ({ ...prev, classes: [...prev.classes, newClass] }));
            setActiveClassId(newClass.id);
        }
        closeModals();
    };

    const saveStudent = (e) => {
        e.preventDefault();
        const cleanEmails = modalEmails.map(email => email.trim()).filter(Boolean);

        const newStudent = {
            name: e.target.name.value.trim(),
            emails: cleanEmails.length > 0 ? cleanEmails : [''],
            notes: e.target.notes.value.trim()
        };

        if (editingItem) {
            setData(prev => ({
                ...prev,
                students: prev.students.map(s => s.id === editingItem.id ? { ...s, ...newStudent } : s)
            }));
        } else {
            setData(prev => ({
                ...prev,
                students: [...prev.students, {
                    id: generateId(),
                    classId: activeClassId,
                    timestamp: '',
                    message: '',
                    emailHistory: [],
                    ...newStudent
                }]
            }));
        }
        closeModals();
    };

    // Adds the contacts confirmed in the import preview.
    // `contacts` = [{ name, emails: string[], notes }], `skippedCount` = rows
    // the preview chose not to import (already present / duplicated).
    const handleBulkAdd = (contacts, skippedCount = 0) => {
        const rows = Array.isArray(contacts) ? contacts : [];
        const newStudents = rows
            .filter(c => c && String(c.name || '').trim() !== '')
            .map(c => {
                const emails = (Array.isArray(c.emails) ? c.emails : [])
                    .map(e => String(e || '').trim())
                    .filter(Boolean);
                return {
                    id: generateId(),
                    classId: activeClassId,
                    name: String(c.name).trim(),
                    emails: emails.length > 0 ? emails : [''],
                    notes: String(c.notes || '').trim(),
                    timestamp: '',
                    message: '',
                    emailHistory: []
                };
            });

        if (newStudents.length > 0) {
            setData(prev => ({
                ...prev,
                students: [...prev.students, ...newStudents]
            }));
        }
        closeModals();
        if (newStudents.length > 0) {
            const skippedNote = skippedCount > 0
                ? ` ${skippedCount} row${skippedCount === 1 ? '' : 's'} skipped (already in your contacts or duplicated).`
                : '';
            showAlert(
                "Import Complete",
                `Added ${newStudents.length} contact${newStudents.length === 1 ? '' : 's'}` +
                (activeClassId ? ' to this group' : '') + '.' + skippedNote
            );
        } else {
            showAlert("Nothing Imported", "No rows with a contact name were imported. Adjust the preview and try again.");
        }
    };

    // Removes one or many contacts (ids) after an explicit confirmation
    const deleteStudents = (ids) => {
        const targets = Array.from(new Set(ids || [])).filter(Boolean);
        if (targets.length === 0) return;

        const isSingle = targets.length === 1;
        const title = isSingle ? "Delete Contact" : `Delete ${targets.length} Contacts`;
        const message = isSingle
            ? "Are you sure you want to delete this contact? This cannot be undone."
            : `Are you sure you want to delete these ${targets.length} contacts? This cannot be undone.`;

        showConfirm(title, message, () => {
            setData(prev => ({
                ...prev,
                students: prev.students.filter(s => !targets.includes(s.id))
            }));
            setSelectedStudents(prev => prev.filter(sId => !targets.includes(sId)));
            setExpandedStudents(prev => prev.filter(sId => !targets.includes(sId)));
            setExpandedEmailContacts(prev => prev.filter(sId => !targets.includes(sId)));
            setLastSelectedStudentId(prev => (prev && targets.includes(prev)) ? null : prev);
            setContextMenu(null);
            closeModals();
        });
    };

    const deleteStudent = (id) => deleteStudents([id]);

    // Close the contact context menu on outside click, scroll, resize, or Escape
    useEffect(() => {
        if (!contextMenu) return;
        const close = () => setContextMenu(null);
        const onKeyDown = (e) => { if (e.key === 'Escape') setContextMenu(null); };
        window.addEventListener('click', close);
        window.addEventListener('contextmenu', close);
        window.addEventListener('resize', close);
        window.addEventListener('scroll', close, true);
        window.addEventListener('keydown', onKeyDown);
        return () => {
            window.removeEventListener('click', close);
            window.removeEventListener('contextmenu', close);
            window.removeEventListener('resize', close);
            window.removeEventListener('scroll', close, true);
            window.removeEventListener('keydown', onKeyDown);
        };
    }, [contextMenu]);

    // Keyboard shortcut: Delete key removes the currently selected contacts
    useEffect(() => {
        const onKeyDown = (e) => {
            if (e.key !== 'Delete' && e.key !== 'Backspace') return;
            const el = e.target;
            const tag = el?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return;
            if (customDialog.isOpen || Object.values(modals).some(Boolean)) return;
            if (!activeClassId || selectedStudents.length === 0) return;
            e.preventDefault();
            deleteStudents(selectedStudents);
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [selectedStudents, activeClassId, customDialog.isOpen, modals]);

    const deleteClass = (id) => {
        showConfirm("Delete Group", "Are you sure you want to delete this group? All contacts within it will be lost.", () => {
            setData(prev => ({
                ...prev,
                classes: prev.classes.filter(c => c.id !== id),
                students: prev.students.filter(s => s.classId !== id)
            }));
            if (activeClassId === id) setActiveClassId(null);
        });
    };

    const deleteFolder = (id) => {
        showConfirm("Delete Folder", "Are you sure you want to delete this folder? All groups and contacts within it will be lost.", () => {
            const classesInFolder = data.classes.filter(c => c.folderId === id).map(c => c.id);
            setData(prev => ({
                ...prev,
                folders: prev.folders.filter(f => f.id !== id),
                classes: prev.classes.filter(c => c.folderId !== id),
                students: prev.students.filter(s => !classesInFolder.includes(s.classId))
            }));
            if (activeFolderId === id) setActiveFolderId(null);
            if (classesInFolder.includes(activeClassId)) setActiveClassId(null);
        });
    };

    const toggleArchiveFolder = (id) => {
        setData(prev => ({
            ...prev,
            folders: prev.folders.map(f => f.id === id ? { ...f, isArchived: !f.isArchived } : f)
        }));
    };

    const toggleArchiveClass = (id) => {
        setData(prev => ({
            ...prev,
            classes: prev.classes.map(c => c.id === id ? { ...c, isArchived: !c.isArchived } : c)
        }));
    };

    // Log level helpers
    const deleteHistoryEntry = (studentId, logId) => {
        showConfirm("Delete Log Entry", "Are you sure you want to delete this specific email log?", () => {
            setData(prev => ({
                ...prev,
                students: prev.students.map(s => {
                    if (s.id === studentId) {
                        const updatedHistory = (s.emailHistory || []).filter(log => log.id !== logId);
                        const mostRecent = updatedHistory[0] || null;
                        return {
                            ...s,
                            emailHistory: updatedHistory,
                            timestamp: mostRecent ? mostRecent.timestamp : '',
                            message: mostRecent ? mostRecent.message : ''
                        };
                    }
                    return s;
                })
            }));
        });
    };

    const clearHistory = () => {
        if (selectedStudents.length === 0) {
            showAlert("No Contacts Selected", "Please select contacts to clear their history.");
            return;
        }
        showConfirm("Clear Selected Logs", "Clear all historical logs for selected contacts? This action cannot be undone.", () => {
            setData(prev => ({
                ...prev,
                students: prev.students.map(s =>
                    selectedStudents.includes(s.id) ? { ...s, timestamp: '', message: '', emailHistory: [] } : s
                )
            }));
            setSelectedStudents([]);
        });
    };

    const closeModals = () => {
        setModals({ folder: false, class: false, student: false, bulkAdd: false, draftEmail: false, backup: false, changelog: false, privacy: false });
        setEditingItem(null);
        setShowSyncConflictModal(false);
        setSyncConflictData(null);
        setShowRestoreChoiceModal(false);
        setPendingRestoreData(null);
    };

    const openEditModal = (type, item) => {
        setEditingItem(item);
        if (type === 'student') {
            setModalEmails(item && item.emails && item.emails.length > 0 ? [...item.emails] : ['']);
        } else {
            setModalEmails(['']);
        }
        setModals(prev => ({ ...prev, [type]: true }));
    };

    const handleAddEmailField = () => {
        setModalEmails(prev => [...prev, '']);
    };

    const handleRemoveEmailField = (index) => {
        if (modalEmails.length === 1) {
            setModalEmails(['']);
        } else {
            setModalEmails(prev => prev.filter((_, idx) => idx !== index));
        }
    };

    const handleEmailValueChange = (index, value) => {
        setModalEmails(prev => {
            const copy = [...prev];
            copy[index] = value;
            return copy;
        });
    };

    // --- Dynamic PDF Export Feature ---
    const handlePrintPDF = () => {
        if (!currentClass || classStudents.length === 0) {
            showAlert("Cannot Generate PDF", "No contacts available to generate a PDF.");
            return;
        }

        // 1. Create a print stylesheet to hide page layout & reveal only the report root during print
        const style = document.createElement('style');
        style.id = 'print-report-style';
        style.innerHTML = `
            @media print {
                /* Hide main application frame */
                body > div:not(#print-report-root) {
                    display: none !important;
                }
                #print-report-root {
                    display: block !important;
                    width: 100% !important;
                    margin: 0 !important;
                    padding: 10px !important;
                    background-color: #ffffff !important;
                    color: #0f172a !important;
                }
                #print-report-root table {
                    width: 100% !important;
                    table-layout: fixed !important;
                    border-collapse: collapse !important;
                }
                #print-report-root th {
                    background-color: #f8fafc !important;
                    -webkit-print-color-adjust: exact !important;
                    print-color-adjust: exact !important;
                    color: #475569 !important;
                }
            }
        `;
        document.head.appendChild(style);

        // 2. Create the printing container in the main document DOM
        const printContainer = document.createElement('div');
        printContainer.id = 'print-report-root';
        printContainer.style.display = 'none'; // Hidden during normal on-screen usage

        const contactsHtml = classStudents.map(student => {
            const cleanEmails = (student.emails || []).filter(Boolean);
            const emailsList = cleanEmails.length > 0
                ? cleanEmails.map(e => `<li style="margin-bottom: 2px; word-break: break-all;">${e}</li>`).join('')
                : '<span style="color: #94a3b8; font-style: italic;">No emails</span>';

            const historyHtml = (student.emailHistory && student.emailHistory.length > 0)
                ? student.emailHistory.map(log => `
            <div style="margin-bottom: 6px; padding-bottom: 4px; border-bottom: 1px dashed #e2e8f0; font-size: 10.5px;">
              <div style="font-weight: 600; font-size: 8px; color: #94a3b8; margin-bottom: 1px;">${formatDate(log.timestamp)}</div>
              <div style="white-space: pre-wrap; color: #0f172a; line-height: 1.35;">${log.message}</div>
            </div>
          `).join('')
                : '<span style="color: #94a3b8; font-style: italic; font-size: 9px;">No communication history</span>';

            return `
        <tr style="border-bottom: 1px solid #cbd5e1; page-break-inside: avoid;">
          <td style="padding: 6px 8px; font-weight: 500; font-size: 9.5px; color: #334155; border-right: 1px solid #cbd5e1; vertical-align: top;">${student.name}</td>
          <td style="padding: 6px 8px; border-right: 1px solid #cbd5e1; font-size: 9px; color: #475569; vertical-align: top;">
            <ul style="margin: 0; padding-left: 0; list-style-type: none;">${emailsList}</ul>
          </td>
          <td style="padding: 6px 8px; color: #475569; border-right: 1px solid #cbd5e1; font-size: 9px; vertical-align: top;">${student.notes || '-'}</td>
          <td style="padding: 6px 8px; vertical-align: top;">${historyHtml}</td>
        </tr>
      `;
        }).join('');

        printContainer.innerHTML = `
          <h1 style="margin: 0 0 2px 0; font-size: 18px; color: #e0466a; font-weight: 700; letter-spacing: -0.02em; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">${currentClass.name} - Batch Emailer</h1>
          <h2 style="margin: 0 0 16px 0; font-size: 10px; font-weight: 500; color: #64748b; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">Generated on ${new Date().toLocaleString()} | Total Contacts: ${classStudents.length}</h2>
          <table style="width: 100%; border-collapse: collapse; margin-top: 10px; table-layout: fixed; border: 1px solid #cbd5e1; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
            <thead>
              <tr style="background-color: #f8fafc;">
                <th style="width: 12%; padding: 6px 8px; text-align: left; border: 1px solid #cbd5e1; font-weight: 600; color: #475569; font-size: 9px; text-transform: uppercase; letter-spacing: 0.05em;">Contact Name</th>
                <th style="width: 16%; padding: 6px 8px; text-align: left; border: 1px solid #cbd5e1; font-weight: 600; color: #475569; font-size: 9px; text-transform: uppercase; letter-spacing: 0.05em;">Email Addresses</th>
                <th style="width: 12%; padding: 6px 8px; text-align: left; border: 1px solid #cbd5e1; font-weight: 600; color: #475569; font-size: 9px; text-transform: uppercase; letter-spacing: 0.05em;">Notes</th>
                <th style="width: 60%; padding: 6px 8px; text-align: left; border: 1px solid #cbd5e1; font-weight: 600; color: #475569; font-size: 9px; text-transform: uppercase; letter-spacing: 0.05em;">Expanded Log History</th>
              </tr>
            </thead>
            <tbody>
              ${contactsHtml}
            </tbody>
          </table>
        `;

        document.body.appendChild(printContainer);

        // Sanitize name and set main window title temporarily to name the print job clean
        const originalTitle = document.title;
        const sanitizedClassName = currentClass.name.replace(/[^a-zA-Z0-9-_]/g, '_');
        document.title = `${sanitizedClassName}_Report_${new Date().toISOString().split('T')[0]}`;

        // Trigger native print process (hides main window UI via CSS injected)
        window.print();

        // Restore original document configurations
        document.title = originalTitle;
        document.body.removeChild(printContainer);
        document.head.removeChild(style);
    };

    const handleSavePDF = async () => {
        if (!currentClass || classStudents.length === 0) {
            showAlert("Cannot Generate PDF", "No contacts available to generate a PDF.");
            return;
        }

        const sanitizedClassName = currentClass.name.replace(/[^a-zA-Z0-9-_]/g, '_');
        const filename = `${sanitizedClassName}_Report_${new Date().toISOString().split('T')[0]}.pdf`;

        try {
            // Load jsPDF and AutoTable from CDN dynamically
            const loadScript = (src) => new Promise((resolve, reject) => {
                if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
                const s = document.createElement('script');
                s.src = src;
                s.onload = resolve;
                s.onerror = reject;
                document.body.appendChild(s);
            });

            await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
            await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js');

            const { jsPDF } = window.jspdf;
            const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
            const pageWidth = doc.internal.pageSize.getWidth();

            // Render Title
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(16);
            doc.setTextColor(224, 70, 106); // #e0466a
            doc.text(`${currentClass.name} - Batch Emailer`, 30, 36);

            // Render Subtitle
            doc.setFont('helvetica', 'normal');
            doc.setFontSize(8);
            doc.setTextColor(100, 116, 139); // #64748b
            doc.text(`Generated on ${new Date().toLocaleString()} | Total Contacts: ${classStudents.length}`, 30, 50);

            // Construct AutoTable dataset
            const tableBody = classStudents.map(student => {
                const emails = (student.emails || []).filter(Boolean).join('\n') || 'No emails';
                const notes = student.notes || '-';
                const history = (student.emailHistory && student.emailHistory.length > 0)
                    ? student.emailHistory.map(log => `[${formatDate(log.timestamp)}]\n${log.message}`).join('\n\n')
                    : 'No communication history';
                return [student.name, emails, notes, history];
            });

            doc.autoTable({
                head: [['Contact Name', 'Email Addresses', 'Notes', 'Expanded Log History']],
                body: tableBody,
                startY: 62,
                margin: { left: 30, right: 30 },
                tableWidth: pageWidth - 60,
                styles: {
                    fontSize: 8,
                    cellPadding: 5,
                    valign: 'top',
                    lineColor: [203, 213, 225],
                    lineWidth: 0.5,
                    textColor: [51, 65, 85],
                    overflow: 'linebreak',
                },
                headStyles: {
                    fillColor: [248, 250, 252],
                    textColor: [71, 85, 105],
                    fontStyle: 'bold',
                    fontSize: 7.5,
                },
                columnStyles: {
                    0: { cellWidth: (pageWidth - 60) * 0.12, fontStyle: 'bold', textColor: [15, 23, 42] },
                    1: { cellWidth: (pageWidth - 60) * 0.16 },
                    2: { cellWidth: (pageWidth - 60) * 0.12 },
                    3: { cellWidth: (pageWidth - 60) * 0.60 },
                },
                alternateRowStyles: { fillColor: [255, 255, 255] },
                rowPageBreak: 'avoid',
            });

            // Extract PDF as a Blob
            const pdfBlob = doc.output('blob');

            // Trigger OS save-as file picker (supported natively on Chrome/Edge)
            if (window.showSaveFilePicker) {
                try {
                    const handle = await window.showSaveFilePicker({
                        suggestedName: filename,
                        types: [{
                            description: 'PDF Document',
                            accept: { 'application/pdf': ['.pdf'] },
                        }],
                    });
                    const writable = await handle.createWritable();
                    await writable.write(pdfBlob);
                    await writable.close();
                } catch (pickerErr) {
                    if (pickerErr.name !== 'AbortError') throw pickerErr;
                }
            } else {
                // Fallback for Safari/Firefox
                const url = URL.createObjectURL(pdfBlob);
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            }
        } catch (error) {
            console.error('Error generating PDF:', error);
            showAlert("Error Saving PDF", "Failed to generate PDF file. Please check your internet connection.");
        }
    };

    // --- Universal Sync & Backup System Handlers ---

    const buildSyncJSON = async (revision = 1, currentData = null) => {
        const activeData = currentData || data;
        const meta = getSyncMeta();
        const rev = Number.isFinite(revision) ? revision : ((meta.baseRevision || 0) + 1);

        const payload = await buildBackupPayload(activeData, rev);
        const jsonStr = await encryptExport(payload);

        // Never report success for a file we cannot prove is complete.
        const summary = await verifyBackupRoundTrip(jsonStr, activeData, payload.settings);

        return {
            jsonStr,
            payload,
            canonicalData: getCanonicalData(activeData),
            contentHash: payload.syncMeta.contentHash,
            revision: rev,
            summary
        };
    };

    const pushToHandle = async (handle, revision, currentData = null) => {
        const activeData = currentData || data;
        if (handle.queryPermission) {
            let perm = await handle.queryPermission({ mode: 'readwrite' });
            if (perm !== 'granted') {
                perm = await handle.requestPermission({ mode: 'readwrite' });
                if (perm !== 'granted') throw new Error("Permission to write file denied");
            }
        }
        const { jsonStr, canonicalData, contentHash } = await buildSyncJSON(revision, activeData);
        try {
            const writable = await handle.createWritable();
            await writable.write(jsonStr);
            await writable.close();
        } catch (e) {
            if (e.name === "NotAllowedError") {
                throw new Error("Permission denied — the file may have been moved or deleted.");
            } else if (e.name === "NotFoundError") {
                throw new Error("File not found — it may have been moved or deleted.");
            } else if (e.name === "NotReadableError") {
                throw new Error("File is not readable — it may be open in another app.");
            }
            throw e;
        }
        const syncedAt = Date.now();
        const fastHash = computeDataHashSync(canonicalData);
        return { syncedAt, contentHash, fastHash, canonicalData };
    };

    const executeSyncResolution = async ({ parsed, file, handle = null, isFirstSetup = false, currentData = null, onPushRequired = null }) => {
        const activeData = currentData || data;
        const meta = getSyncMeta();
        const localCanonical = getCanonicalData(activeData);
        const localHash = await computeDataHash(localCanonical);
        const localFastHash = computeDataHashSync(localCanonical);

        let fileNormalized = null;
        let fileCanonical = null;
        let fileHash = null;
        let fileFastHash = null;

        if (parsed) {
            fileNormalized = normalizeImportedData(parsed);
            fileCanonical = getCanonicalData(fileNormalized);
            fileHash = await computeDataHash(fileCanonical);
            fileFastHash = computeDataHashSync(fileCanonical);
        }

        const fileMeta = parsed?.syncMeta || null;
        const fileRevision = Number.isFinite(fileMeta?.revision) ? fileMeta.revision : 1;
        const fileName = file?.name || meta.fileName || "batch_emailer_sync.json";

        const doPull = () => {
            setData(fileNormalized);
            setActiveFolderId(null);
            setActiveClassId(null);
            const syncedAt = Date.now();
            setSyncMeta({
                fileName,
                lastSyncedRevision: fileRevision,
                lastSyncedContentHash: fileHash,
                baseRevision: fileRevision,
                baseContentHash: fileHash,
                baseFastHash: fileFastHash,
                lastSyncedAt: syncedAt,
                lastLocalChange: syncedAt,
                externalUpdateAvailable: false,
                externalUpdateAuthor: null
            });
            setSyncFileName(fileName);
            setSyncStatus('synced');
            showSyncToast(`Synced — pulled updates from ${fileName}.`, 'success');
        };

        const doPush = async (rev) => {
            if (handle) {
                const { syncedAt, contentHash, fastHash } = await pushToHandle(handle, rev, activeData);
                setSyncMeta({
                    fileName,
                    lastSyncedRevision: rev,
                    lastSyncedContentHash: contentHash,
                    baseRevision: rev,
                    baseContentHash: contentHash,
                    baseFastHash: fastHash,
                    lastSyncedAt: syncedAt,
                    lastLocalChange: syncedAt,
                    externalUpdateAvailable: false,
                    externalUpdateAuthor: null
                });
                setSyncFileName(fileName);
                setSyncStatus('synced');
                showSyncToast(`Synced — pushed changes to ${fileName}.`, 'success');
            } else if (onPushRequired) {
                await onPushRequired(rev, localHash);
            }
        };

        // Case 0: Hashes identical
        if (fileHash && localHash === fileHash) {
            const syncedAt = Date.now();
            setSyncMeta({
                fileName,
                lastSyncedRevision: fileRevision,
                lastSyncedContentHash: localHash,
                baseRevision: fileRevision,
                baseContentHash: localHash,
                baseFastHash: localFastHash,
                lastSyncedAt: syncedAt,
                lastLocalChange: syncedAt,
                externalUpdateAvailable: false,
                externalUpdateAuthor: null
            });
            setSyncFileName(fileName);
            setSyncStatus('synced');
            showSyncToast("Already in sync.", "info");
            return;
        }

        // Case 1: First-time setup when one side has no data
        const localEmpty = activeData.folders.length === 0 && activeData.classes.length === 0 && activeData.students.length === 0;
        const fileEmpty = !!(fileNormalized && fileNormalized.folders.length === 0 && fileNormalized.classes.length === 0 && fileNormalized.students.length === 0);

        if (isFirstSetup) {
            if (!fileEmpty && localEmpty) {
                doPull();
                return;
            } else if (fileEmpty && !localEmpty) {
                await doPush(1);
                return;
            }
        }

        // Case 2: 3-Way check against base
        const baseHash = meta.baseContentHash || meta.lastSyncedContentHash || null;
        const baseRev = meta.baseRevision || meta.lastSyncedRevision || 0;

        // Has local genuinely changed since last sync?
        const localChanged = baseHash ? (localHash !== baseHash) : syncNeedsPush(activeData);

        // Has the file changed since this device last synced?
        const fileChanged = baseHash ? (fileHash !== baseHash) : (fileRevision > baseRev);

        // Only file changed -> clean PULL
        if (fileChanged && !localChanged) {
            doPull();
            return;
        }

        // Only local changed -> clean PUSH
        if (localChanged && !fileChanged) {
            const nextRev = Math.max(fileRevision, baseRev) + 1;
            await doPush(nextRev);
            return;
        }

        // Both changed -> True conflict
        const localFP = generateDataFingerprint(activeData);
        const fileFP = generateDataFingerprint(fileNormalized);
        const comparison = compareFingerprints(localFP, fileFP) || { differences: [], hasDifferences: true };
        comparison.localDevice = `${getDeviceName()} (unsynced edits)`;
        comparison.fileDevice = fileMeta?.deviceName ? `${fileMeta.deviceName} (rev ${fileRevision})` : `Sync file (rev ${fileRevision})`;

        setSyncConflictData({
            comparison,
            parsed: fileNormalized,
            fileRevision,
            fileHash,
            fileFastHash,
            fileCanonical,
            handle,
            onPushRequired,
            fileName
        });
        setShowSyncConflictModal(true);
    };

    const syncWithHandle = async (handle, isFirstSetup = false) => {
        let perm;
        try {
            perm = await handle.queryPermission({ mode: "readwrite" });
        } catch (e) {
            showSyncToast("Can't check file permission — " + e.message, "error");
            return;
        }

        if (perm !== "granted") {
            try {
                perm = await handle.requestPermission({ mode: "readwrite" });
            } catch (e) {
                showSyncToast("Can't request file permission — " + e.message, "error");
                return;
            }
            if (perm !== "granted") {
                showSyncToast("Permission denied — click Sync and choose the file again.", "error");
                return;
            }
        }

        let fileResult;
        try {
            fileResult = await readSyncFile(handle);
        } catch (e) {
            showSyncToast("Can't read sync file — " + e.message, "error");
            return;
        }

        const { file, parsed } = fileResult;
        await executeSyncResolution({
            parsed,
            file,
            handle,
            isFirstSetup,
            currentData: data
        });
    };

    const autoSync = async () => {
        if (syncStatus === 'syncing') return;
        setSyncStatus('syncing');
        setExternalBanner(null);
        setSyncMeta({ externalUpdateAvailable: false, externalUpdateAuthor: null });

        try {
            const hasFSA = !!(window.showSaveFilePicker || window.showOpenFilePicker);
            const meta = getSyncMeta();
            const hadFileBefore = !!meta.fileName;

            // Pick a file and connect it as the sync file. Failures here (for
            // example an IndexedDB problem) used to escape as a raw DOMException.
            const connectAndSync = async (promptMessage, promptType = "info") => {
                if (promptMessage) showSyncToast(promptMessage, promptType);
                const newHandle = await pickSyncFile();
                if (!newHandle) return;
                try {
                    await setSyncHandle(newHandle);
                    setSyncFileName(newHandle.name);
                    setSyncMeta({ fileName: newHandle.name });
                    await syncWithHandle(newHandle, true);
                } catch (e) {
                    console.error("[Sync] could not connect to the chosen file:", e);
                    showSyncToast(`Couldn't sync with "${newHandle.name}" — ` + describeSyncError(e), "error");
                    setSyncStatus('error');
                }
            };

            if (hasFSA) {
                let handle = await getSyncHandle();
                if (handle) {
                    try {
                        await syncWithHandle(handle, false);
                    } catch (e) {
                        console.error("[Sync] sync error with handle:", e);
                        const isHandleError = e.name === "NotFoundError" || e.name === "NotReadableError"
                            || e.name === "NotAllowedError" || e.name === "SecurityError";
                        if (isHandleError) {
                            try {
                                await clearSyncHandle();
                            } catch (clearError) {
                                console.warn("[Sync] could not clear the stored handle:", clearError);
                            }
                            await connectAndSync(`Connection to "${meta.fileName}" lost — please choose the file again.`, "warn");
                        } else {
                            showSyncToast("Sync failed: " + describeSyncError(e), "error");
                            setSyncStatus('error');
                        }
                    }
                } else if (hadFileBefore) {
                    await connectAndSync(`Please choose "${meta.fileName}" to reconnect.`);
                } else {
                    // First time setup
                    await connectAndSync();
                }
            } else {
                // Non-FSA fallback (Safari / Firefox / Mobile)
                const mobileInput = document.getElementById("mobile-sync-pull-input");
                if (mobileInput) {
                    mobileInput.click();
                }
            }
        } catch (e) {
            console.error("[Sync] autoSync unexpected error:", e);
            showSyncToast("Sync error: " + describeSyncError(e), "error");
            setSyncStatus('error');
        } finally {
            const meta = getSyncMeta();
            if (syncNeedsPush(data)) {
                setSyncStatus('local-changes');
            } else if (meta.fileName) {
                setSyncStatus('synced');
            } else {
                setSyncStatus('idle');
            }
        }
    };

    const handleSync = autoSync;

    const mobilePushSync = async (fileName, revision = 1) => {
        const { jsonStr, canonicalData, contentHash } = await buildSyncJSON(revision, data);
        const safeName = (fileName || getSyncMeta().fileName || "batch_emailer_sync").replace(/\.json$/i, "") + ".json";

        if (navigator.share && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)) {
            try {
                const blob = new Blob([jsonStr], { type: "application/json" });
                const file = new File([blob], safeName, { type: "application/json" });
                if (navigator.canShare && navigator.canShare({ files: [file] })) {
                    await navigator.share({ files: [file] });
                    const syncedAt = Date.now();
                    const fastHash = computeDataHashSync(canonicalData);
                    setSyncMeta({
                        fileName: safeName,
                        lastSyncedRevision: revision,
                        lastSyncedContentHash: contentHash,
                        baseRevision: revision,
                        baseContentHash: contentHash,
                        baseFastHash: fastHash,
                        lastSyncedAt: syncedAt,
                        lastLocalChange: syncedAt,
                        externalUpdateAvailable: false,
                        externalUpdateAuthor: null
                    });
                    setSyncFileName(safeName);
                    setSyncStatus('synced');
                    showSyncToast(`Synced — saved to ${safeName}.`, "success");
                    return;
                }
            } catch (e) {
                if (e.name === "AbortError") return;
            }
        }

        const result = await saveFileAs(jsonStr, safeName, "application/json");
        if (result === 'cancelled') {
            showSyncToast("Sync cancelled — nothing was written to disk.", "info");
            setSyncStatus(syncNeedsPush(data) ? 'local-changes' : 'idle');
            return;
        }
        const syncedAt = Date.now();
        const fastHash = computeDataHashSync(canonicalData);
        setSyncMeta({
            fileName: safeName,
            lastSyncedRevision: revision,
            lastSyncedContentHash: contentHash,
            baseRevision: revision,
            baseContentHash: contentHash,
            baseFastHash: fastHash,
            lastSyncedAt: syncedAt,
            lastLocalChange: syncedAt,
            externalUpdateAvailable: false,
            externalUpdateAuthor: null
        });
        setSyncFileName(safeName);
        setSyncStatus('synced');
        showSyncToast(`Synced — downloaded ${safeName}. Save it to your sync folder.`, "success");
    };

    const handleMobileSyncPull = async (event) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file) {
            setSyncStatus(syncNeedsPush(data) ? 'local-changes' : (syncFileName ? 'synced' : 'idle'));
            return;
        }

        setSyncStatus('syncing');
        try {
            const text = await file.text();
            const parsed = await parseExport(text);
            if (!parsed || typeof parsed !== 'object' || (!Array.isArray(parsed.folders) && !Array.isArray(parsed.classes) && !Array.isArray(parsed.students))) {
                showSyncToast("That file doesn't contain valid Batch Emailer data.", "error");
                setSyncStatus('error');
                return;
            }

            await executeSyncResolution({
                parsed,
                file,
                handle: null,
                isFirstSetup: !getSyncMeta().fileName,
                currentData: data,
                onPushRequired: async (rev) => {
                    await mobilePushSync(file.name, rev);
                }
            });
        } catch (e) {
            console.error("[Sync] mobile pull error:", e);
            showSyncToast("Error reading sync file: " + e.message, "error");
            setSyncStatus('error');
        }
    };

    const handleChangeSyncFile = async () => {
        const hasFSA = !!(window.showSaveFilePicker || window.showOpenFilePicker);
        if (hasFSA) {
            const handle = await pickSyncFile();
            if (!handle) return;
            try {
                await setSyncHandle(handle);
                setSyncFileName(handle.name);
                setSyncMeta({ fileName: handle.name });
                await syncWithHandle(handle, true);
            } catch (e) {
                console.error("[Sync] could not switch sync file:", e);
                showSyncToast(`Couldn't sync with "${handle.name}" — ` + describeSyncError(e), "error");
                setSyncStatus('error');
            }
        } else {
            showConfirm("Change Sync File", "Choose a new sync file on your device?", () => {
                localStorage.removeItem(SYNC_META_KEY);
                const input = document.getElementById("mobile-sync-pull-input");
                if (input) input.click();
            });
        }
    };

    const handleDisconnectSync = async () => {
        showConfirm("Disconnect Sync", "Disconnecting will stop syncing with this file. Your local data will remain unchanged.", async () => {
            try {
                await clearSyncHandle();
            } catch (e) {
                console.error("[Sync] could not clear the stored handle:", e);
                showSyncToast("Couldn't disconnect the sync file — " + describeSyncError(e), "error");
                setSyncStatus('error');
                return;
            }
            setSyncMeta({
                fileName: null,
                baseRevision: null,
                baseContentHash: null,
                baseFastHash: null,
                lastSyncedAt: null,
                lastSyncedRevision: null,
                lastSyncedContentHash: null
            });
            setSyncFileName('');
            setSyncStatus('idle');
            showAlert("Disconnected", "Sync file disconnected successfully.");
        });
    };

    const handleResolveConflictKeepFile = () => {
        if (!syncConflictData) return;
        setData(syncConflictData.parsed);
        setActiveFolderId(null);
        setActiveClassId(null);
        setSyncMeta({
            fileName: syncConflictData.fileName,
            baseRevision: syncConflictData.fileRevision,
            lastSyncedRevision: syncConflictData.fileRevision,
            baseContentHash: syncConflictData.fileHash,
            lastSyncedContentHash: syncConflictData.fileHash,
            baseFastHash: computeDataHashSync(syncConflictData.fileCanonical),
            lastSyncedAt: Date.now()
        });
        setSyncFileName(syncConflictData.fileName);
        setSyncStatus('synced');
        setShowSyncConflictModal(false);
        setSyncConflictData(null);
        showAlert("Sync Resolved", "File data applied successfully.");
    };

    const handleResolveConflictKeepLocal = async () => {
        if (!syncConflictData) return;
        try {
            const nextRev = Math.max(syncConflictData.fileRevision || 0, getSyncMeta().baseRevision || 0) + 1;
            if (syncConflictData.handle) {
                await pushToHandle(syncConflictData.handle, nextRev, data);
            } else if (syncConflictData.onPushRequired) {
                await syncConflictData.onPushRequired(nextRev);
            }
            setSyncFileName(syncConflictData.fileName);
            setSyncStatus('synced');
            setShowSyncConflictModal(false);
            setSyncConflictData(null);
            showAlert("Sync Resolved", "Overwrote sync file with your local data.");
        } catch (err) {
            showAlert("Resolution Failed", "Could not write to file: " + (err.message || err));
        }
    };

    const handleExportBackup = async () => {
        try {
            const meta = getSyncMeta();
            const revision = Number.isFinite(meta.baseRevision) ? meta.baseRevision : 1;
            const { jsonStr } = await buildSyncJSON(revision, data);
            const dateStr = new Date().toISOString().split('T')[0];
            const filename = `batch_emailer_backup_${dateStr}.json`;
            const contents = `This backup contains everything: ${describeDataSummary(data)}.`;

            // Mobile Native Web Share API
            if (navigator.share && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)) {
                try {
                    const blob = new Blob([jsonStr], { type: "application/json" });
                    const file = new File([blob], filename, { type: "application/json" });
                    if (navigator.canShare && navigator.canShare({ files: [file] })) {
                        await navigator.share({ files: [file] });
                        showAlert("Backup Shared", `${filename} was shared. ${contents}`);
                        return;
                    }
                } catch {
                    // fall through to saveFileAs
                }
            }

            const result = await saveFileAs(jsonStr, filename, "application/json");
            if (result === 'cancelled') return;
            showAlert("Backup Saved", `${filename} was verified after writing. ${contents}`);
        } catch (err) {
            console.error("Backup export error:", err);
            showAlert("Export Failed", "Could not create backup file: " + (err.message || err));
        }
    };

    const restoreFromBackup = async (e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;

        try {
            const text = await file.text();
            const parsed = await parseExport(text);

            if (!parsed || typeof parsed !== 'object') {
                showAlert("Error", "Invalid backup file: Not valid JSON or file is empty.");
                return;
            }

            const hasData = Array.isArray(parsed.folders) || Array.isArray(parsed.classes) || Array.isArray(parsed.students);
            if (!hasData) {
                showAlert("Error", "Invalid backup file format: Expected Batch Emailer data structure.");
                return;
            }

            const normalized = normalizeImportedData(parsed);
            setPendingRestoreData({
                normalized,
                raw: parsed,
                settings: readBackupSettings(parsed),
                fileName: file.name
            });
            setShowRestoreChoiceModal(true);
        } catch (err) {
            console.error("Restore error:", err);
            showAlert("Error", "Failed to read backup file: " + (err.message || err));
        }
    };

    const handleRestoreReplaceAll = async () => {
        if (!pendingRestoreData) return;
        const { normalized, raw, settings, fileName } = pendingRestoreData;
        const canonical = getCanonicalData(normalized);
        const hash = await computeDataHash(canonical);
        const fastHash = computeDataHashSync(canonical);
        const fileRev = Number.isFinite(raw.syncMeta?.revision) ? raw.syncMeta.revision : 1;

        setData(normalized);
        if (settings && (settings.theme === 'light' || settings.theme === 'dark')) {
            setTheme(settings.theme);
        }
        setActiveFolderId(null);
        setActiveClassId(null);

        setSyncMeta({
            fileName: fileName || getSyncMeta().fileName,
            baseRevision: fileRev,
            lastSyncedRevision: fileRev,
            baseContentHash: hash,
            lastSyncedContentHash: hash,
            baseFastHash: fastHash,
            lastSyncedAt: Date.now()
        });

        setShowRestoreChoiceModal(false);
        setPendingRestoreData(null);
        closeModals();
        setSyncStatus('synced');
        showAlert("Restore Complete", "All data has been successfully replaced from the backup.");
    };

    const handleRestoreImportNew = () => {
        if (!pendingRestoreData) return;
        const { normalized } = pendingRestoreData;

        const existingFolderIds = new Set(data.folders.map(f => f.id));
        const existingClassIds = new Set(data.classes.map(c => c.id));
        const existingStudentIds = new Set(data.students.map(s => s.id));

        const newFolders = normalized.folders.filter(f => !existingFolderIds.has(f.id));
        const newClasses = normalized.classes.filter(c => !existingClassIds.has(c.id));
        const incomingStudents = normalized.students.filter(s => !existingStudentIds.has(s.id));

        // Existing contacts keep their identity but absorb anything the backup
        // has that they don't — especially extra email messages.
        let mergedContacts = 0;
        let addedMessages = 0;
        const snapshot = (s) => JSON.stringify({
            name: s.name || '',
            notes: s.notes || '',
            classId: s.classId || null,
            emails: [...(s.emails || [])].sort(),
            history: [...(s.emailHistory || [])]
                .sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')))
        });
        const localStudents = data.students.map(local => {
            const incoming = normalized.students.find(s => s.id === local.id);
            if (!incoming) return local;
            const merged = mergeContactRecords(local, incoming);
            if (snapshot(merged) !== snapshot(local)) mergedContacts += 1;
            const before = Array.isArray(local.emailHistory) ? local.emailHistory.length : 0;
            const after = Array.isArray(merged.emailHistory) ? merged.emailHistory.length : 0;
            if (after > before) addedMessages += after - before;
            return merged;
        });

        const nothingNew = newFolders.length === 0 && newClasses.length === 0
            && incomingStudents.length === 0 && mergedContacts === 0;

        if (nothingNew) {
            setShowRestoreChoiceModal(false);
            setPendingRestoreData(null);
            closeModals();
            showAlert("Import Complete", "No new items found. Every contact and every email message in the backup already exists in your data.");
            return;
        }

        const merged = {
            folders: [...data.folders, ...newFolders],
            classes: [...data.classes, ...newClasses],
            students: [...localStudents, ...incomingStudents]
        };

        setData(merged);
        noteLocalChange(merged);

        setShowRestoreChoiceModal(false);
        setPendingRestoreData(null);
        closeModals();

        const parts = [];
        if (incomingStudents.length > 0) {
            parts.push(`${incomingStudents.length} new contact${incomingStudents.length === 1 ? '' : 's'}`);
        }
        if (newFolders.length > 0) {
            parts.push(`${newFolders.length} folder${newFolders.length === 1 ? '' : 's'}`);
        }
        if (newClasses.length > 0) {
            parts.push(`${newClasses.length} group${newClasses.length === 1 ? '' : 's'}`);
        }
        if (addedMessages > 0) {
            parts.push(`${addedMessages} new email message${addedMessages === 1 ? '' : 's'} merged into ${mergedContacts} existing contact${mergedContacts === 1 ? '' : 's'}`);
        } else if (mergedContacts > 0) {
            parts.push(`missing details for ${mergedContacts} existing contact${mergedContacts === 1 ? '' : 's'}`);
        }
        showAlert("Import Complete", `Imported ${parts.join(', ')}.`);
    };

    // Theme Constants (Monokai Pro inspired)
    const isDark = theme === 'dark';
    const themeClasses = {
        appBg: isDark ? 'bg-[#2d2a2e] text-[#fcfaf2]' : 'bg-[#faf8f2] text-[#2d2a2e]',
        sidebarBg: isDark ? 'bg-[#221f22] border-[#4a474a]' : 'bg-[#f5ecf7] border-[#e1d5e3]',
        headerBg: isDark ? 'bg-[#2d2a2e]/90 border-[#4a474a]' : 'bg-[#faf8f2]/90 border-[#e1d5e3]',
        cardBg: isDark ? 'bg-[#3a373a] border-[#4a474a]' : 'bg-[#ffffff] border-[#e1d5e3]',
        altRowBg: isDark ? 'hover:bg-[#3a373a]/30' : 'hover:bg-[#f2ece0]/40',
        selectedRowBg: isDark ? 'bg-[#ff6188]/10 hover:bg-[#ff6188]/15' : 'bg-[#ff6188]/10 hover:bg-[#ff6188]/15',
        textPrimary: isDark ? 'text-[#fcfaf2]' : 'text-[#2d2a2e]',
        textSecondary: isDark ? 'text-[#c1c0c1]' : 'text-[#595559]',
        textMuted: isDark ? 'text-[#939293]' : 'text-[#726f73]',
        textAccent: isDark ? 'text-[#ff6188]' : 'text-[#e0466a]',
        border: isDark ? 'border-[#4a474a]' : 'border-[#e1d5e3]',
        badgeBg: isDark ? 'bg-[#403e41] text-[#fcfaf2]' : 'bg-[#e1d5e3] text-[#2d2a2e]',
        tableHeaderBg: isDark ? 'bg-[#221f22] border-[#4a474a] text-[#ff6188]' : 'bg-[#f0e4f2] border-[#e1d5e3] text-[#e0466a]',
        inputBg: isDark ? 'bg-[#221f22] border-[#4a474a] text-[#fcfaf2] focus:border-[#ff6188] focus:ring-[#ff6188]/20' : 'bg-white border-[#e1d5e3] text-[#2d2a2e] focus:ring-[#ab9df2]/20 focus:border-[#ab9df2]',

        // Accents
        accentYellow: '#ffd866',
        accentOrange: '#fc9867',
        accentRed: '#ff6188',
        accentGreen: '#a9dc76',
        accentCyan: '#78dce8',
        accentPurple: '#ab9df2',

        // Buttons
        btnPrimary: isDark ? 'bg-[#ff6188] hover:bg-[#ff80a2] text-white shadow-[#ff6188]/5 shadow-lg' : 'bg-[#e0466a] hover:bg-[#ff6188] text-white shadow-md',
        btnSecondary: isDark ? 'bg-[#403e41] hover:bg-[#4a474a] text-[#fcfaf2] border border-[#595559]' : 'bg-[#ffffff] hover:bg-[#faf8f2] text-[#2d2a2e] border border-[#dfd9cd] shadow-sm',
        btnDanger: isDark ? 'bg-[#ff6188]/20 hover:bg-[#ff6188]/30 text-[#ff6188] border border-[#ff6188]/30' : 'bg-[#e0466a]/10 hover:bg-[#e0466a]/20 text-[#e0466a] border border-[#e0466a]/20'
    };

    // Contact context menu: the contact that was right-clicked, and what a "Delete" click removes
    const contextTargetStudent = contextMenu ? classStudents.find(s => s.id === contextMenu.studentId) : null;
    const contextMenuTargets = contextMenu
        ? (contextTargetStudent && selectedStudents.includes(contextTargetStudent.id) && selectedStudents.length > 1
            ? selectedStudents
            : [contextMenu.studentId])
        : [];
    const contextMenuDeleteLabel = contextMenuTargets.length > 1
        ? `Delete ${contextMenuTargets.length} Contacts`
        : 'Delete Contact';

    return (
        <div className={`flex h-screen font-sans relative overflow-hidden transition-colors duration-300 ${sidebarOpen ? '' : 'sidebar-closed'} ${themeClasses.appBg}`}>

            {/* Semi-transparent responsive backdrop overlay when sidebar is open on mobile */}
            {sidebarOpen && (
                <div
                    className="fixed inset-0 bg-black/45 z-20 md:hidden transition-opacity duration-300"
                    onClick={() => setSidebarOpen(false)}
                />
            )}

            {/* Sidebar with dynamic, theme-specific background classes */}
            <div className={`sidebar-container ${sidebarOpen ? 'w-72' : 'w-0 -translate-x-full'} transition-all duration-300 ease-in-out border-r flex flex-col flex-shrink-0 absolute md:relative z-30 h-full overflow-hidden shadow-xl md:shadow-none ${themeClasses.sidebarBg}`}>

                {/* Mobile close button positioned neatly at the top of the sidebar on narrow screens */}
                <div className="md:hidden p-4 flex justify-end border-b border-gray-250/10">
                    <button className="p-1.5 hover:bg-gray-500/10 rounded-lg transition-colors" onClick={() => setSidebarOpen(false)}>
                        <X size={20} />
                    </button>
                </div>

                <div className={`p-4 flex flex-col gap-2 border-b transition-colors duration-300 ${isDark ? 'border-[#4a474a]/40' : 'border-[#e1d5e3]/50'}`}>
                    <button
                        onClick={() => setModals({ ...modals, folder: true })}
                        className={`flex items-center justify-center gap-2 w-full py-2 rounded-lg font-semibold transition-all active:scale-[0.98] ${isDark ? 'bg-[#ff6188]/10 text-[#ff6188] hover:bg-[#ff6188]/20' : 'bg-[#e0466a]/15 text-[#e0466a] hover:bg-[#e0466a]/25'
                            }`}
                    >
                        <Plus size={18} /> New Folder
                    </button>
                    <button
                        onClick={() => setModals({ ...modals, backup: true })}
                        className={`flex items-center justify-center gap-2 w-full py-2 px-3 rounded-lg font-semibold transition-all active:scale-[0.98] ${isDark ? 'bg-[#403e41] text-[#fcfaf2] hover:bg-[#4a474a] border border-[#595559]' : 'bg-[#ffffff] text-[#2d2a2e] hover:bg-[#faf8f2] border border-[#dfd9cd]'
                            }`}
                    >
                        <RefreshCw size={18} className={syncStatus === 'syncing' ? 'animate-spin text-[#78dce8]' : ''} />
                        <span>Sync & Backup</span>
                        {syncStatus === 'synced' && (
                            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 ml-auto flex-shrink-0" title="In Sync"></span>
                        )}
                        {syncStatus === 'local-changes' && (
                            <span className="w-2.5 h-2.5 rounded-full bg-amber-500 ml-auto flex-shrink-0" title="Unsynced local changes"></span>
                        )}
                        {syncStatus === 'error' && (
                            <span className="w-2.5 h-2.5 rounded-full bg-rose-500 ml-auto flex-shrink-0" title="Sync error"></span>
                        )}
                    </button>
                </div>

                {/* Privacy Policy Link */}
                <button
                    onClick={() => setModals({ ...modals, privacy: true })}
                    className={`mx-4 mt-2 mb-0 flex items-center justify-center gap-2 py-2 rounded-lg text-xs font-bold transition-all active:scale-[0.98] ${isDark ? 'text-[#78dce8] hover:bg-[#78dce8]/10' : 'text-[#2188a0] hover:bg-[#78dce8]/15'}`}
                >
                    <FileText size={14} /> Privacy Policy
                </button>

                {/* Sidebar Backup Reminder Alert */}
                <div className={`px-4 py-3 mx-4 mt-2 mb-1 rounded-xl border flex gap-2.5 items-start text-xs leading-relaxed ${isDark ? 'bg-[#78dce8]/10 border-[#78dce8]/30 text-[#78dce8]' : 'bg-[#2188a0]/10 border-[#2188a0]/30 text-[#13677a]'
                    }`}>
                    <RefreshCw size={15} className="flex-shrink-0 mt-0.5" />
                    <div>
                        {syncFileName ? (
                            <span>Connected to <strong>{syncFileName}</strong>.</span>
                        ) : (
                            <span>Connect a <strong>Sync File</strong> for 1-click cloudless sync, or export backups.</span>
                        )}
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto p-3 space-y-4">
                    {activeFolders.length === 0 && (
                        <div className={`text-center text-sm ${themeClasses.textMuted} mt-4`}>
                            No folders found. Create one to get started.
                        </div>
                    )}

                    {activeFolders.map(folder => {
                        const isOpen = !!expandedFolders[folder.id];
                        const groupCount = data.classes.filter(c => c.folderId === folder.id && (showArchived ? true : !c.isArchived)).length;
                        return (
                            <div key={folder.id} className="space-y-1">
                                <div
                                    className={`group flex items-center justify-between p-2 rounded-md cursor-pointer transition-all duration-200 ${activeFolderId === folder.id
                                        ? (isDark ? 'bg-[#3a373a] font-semibold text-white' : 'bg-[#e1d5e3]/65 font-semibold text-[#2d2a2e]')
                                        : (isDark ? 'hover:bg-[#3a373a]/30' : 'hover:bg-[#e1d5e3]/30')
                                        }`}
                                    onClick={() => toggleFolder(folder.id)}
                                >
                                    <div className="flex items-center gap-2 text-sm truncate flex-1">
                                        <ChevronDown
                                            size={14}
                                            className={`transition-transform duration-200 text-gray-400 shrink-0 ${isOpen ? 'rotate-0' : '-rotate-90'
                                                }`}
                                        />
                                        {isOpen ? (
                                            <FolderOpen size={16} className={`shrink-0 ${activeFolderId === folder.id ? 'text-[#ff6188]' : 'text-gray-400'}`} />
                                        ) : (
                                            <Folder size={16} className={`shrink-0 ${activeFolderId === folder.id ? 'text-[#ff6188]' : 'text-gray-400'}`} />
                                        )}
                                        <span className="truncate max-w-[140px]" title={folder.name}>{folder.name}</span>
                                        {folder.isArchived && <span className="text-[10px] bg-[#fc9867]/20 text-[#fc9867] border border-[#fc9867]/30 px-1.5 py-0.5 rounded font-bold shrink-0">Archive</span>}
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <span className={`text-xs px-2 py-0.5 rounded-full font-bold ml-auto group-hover:hidden transition-all duration-200 ${isDark ? 'bg-zinc-800 text-[#ff6188]' : 'bg-[#e1d5e3] text-[#e0466a]'
                                            }`}>
                                            {groupCount}
                                        </span>
                                        <div className="hidden group-hover:flex items-center gap-1 transition-all">
                                            <button onClick={(e) => { e.stopPropagation(); openEditModal('folder', folder); }} className="p-1 text-gray-400 hover:text-[#ff6188] transition-colors"><Edit2 size={13} /></button>
                                            <button onClick={(e) => { e.stopPropagation(); toggleArchiveFolder(folder.id); }} className="p-1 text-gray-400 hover:text-[#fc9867] transition-colors"><Archive size={13} /></button>
                                            <button onClick={(e) => { e.stopPropagation(); deleteFolder(folder.id); }} className="p-1 text-gray-400 hover:text-[#ff6188] transition-colors"><Trash2 size={13} /></button>
                                        </div>
                                    </div>
                                </div>

                                <div
                                    className={`grid transition-all duration-300 ease-in-out ${isOpen ? 'grid-rows-[1fr] opacity-100 mt-1' : 'grid-rows-[0fr] opacity-0'
                                        }`}
                                >
                                    <div className="overflow-hidden">
                                        <div className="pl-6 space-y-1 pb-1">
                                            {activeClasses.filter(c => c.folderId === folder.id).map(cls => (
                                                <div
                                                    key={cls.id}
                                                    className={`group flex items-center justify-between p-2 rounded-md cursor-pointer transition-all duration-200 text-sm ${activeClassId === cls.id
                                                        ? (isDark ? 'bg-[#ab9df2]/15 text-[#ab9df2] font-semibold' : 'bg-[#ab9df2]/20 text-[#5c4cb0] font-semibold')
                                                        : (isDark ? 'hover:bg-[#3a373a]/20 text-[#939293]' : 'hover:bg-[#e1d5e3]/20 text-[#726f73]')
                                                        }`}
                                                    onClick={() => { setActiveClassId(cls.id); setSelectedStudents([]); }}
                                                >
                                                    <div className="flex items-center gap-2 truncate">
                                                        <Book size={14} className={activeClassId === cls.id ? 'text-[#ab9df2]' : 'text-gray-400'} />
                                                        <span className="truncate max-w-[120px]" title={cls.name}>{cls.name}</span>
                                                        {cls.isArchived && <span className="text-[10px] bg-[#fc9867]/20 text-[#fc9867] border border-[#fc9867]/30 px-1.5 py-0.5 rounded font-bold">Archive</span>}
                                                    </div>
                                                    <div className="hidden group-hover:flex items-center gap-1">
                                                        <button onClick={(e) => { e.stopPropagation(); openEditModal('class', cls); }} className="p-1 text-gray-400 hover:text-[#ff6188] transition-colors"><Edit2 size={13} /></button>
                                                        <button onClick={(e) => { e.stopPropagation(); toggleArchiveClass(cls.id); }} className="p-1 text-gray-400 hover:text-[#fc9867] transition-colors"><Archive size={13} /></button>
                                                        <button onClick={(e) => { e.stopPropagation(); deleteClass(cls.id); }} className="p-1 text-gray-400 hover:text-[#ff6188] transition-colors"><Trash2 size={13} /></button>
                                                    </div>
                                                </div>
                                            ))}
                                            <button
                                                onClick={() => { setEditingItem(null); setModals({ ...modals, class: true }); }}
                                                className="flex items-center gap-2 text-xs text-gray-500 hover:text-blue-600 p-2 w-full text-left transition-colors font-semibold"
                                            >
                                                <Plus size={14} /> Add Group
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
                <div className={`p-3 border-t text-xs flex justify-between items-center ${isDark ? 'bg-zinc-900 border-[#4a474a]' : 'bg-[#e4d6eb] border-[#e1d5e3] text-[#726f73]'}`}>
                    <label className="flex items-center gap-2 cursor-pointer font-medium">
                        <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} className="rounded text-blue-600 focus:ring-blue-500 cursor-pointer" />
                        Show Archived
                    </label>
                </div>
            </div>

            {/* Main Content Area */}
            <div className="flex-1 flex flex-col h-full overflow-hidden relative w-full">

                {/* Header toolbar with centralized 'Batch Emailer' title */}
                <div className={`flex items-center justify-between p-4 border-b transition-colors duration-300 ${themeClasses.headerBg} backdrop-blur-md sticky top-0 z-10`}>
                    <div className="flex items-center gap-3">
                        <button onClick={() => setSidebarOpen(!sidebarOpen)} className={`p-1.5 rounded-lg transition-colors ${isDark ? 'hover:bg-[#3a373a]' : 'hover:bg-[#f2ece0]'} focus:outline-none`} title="Toggle Sidebar">
                            <Menu size={22} />
                        </button>
                        <div className="flex flex-col">
                            <div className="flex items-center gap-2">
                                <span className="font-bold text-lg md:text-xl flex items-center gap-2 select-none">
                                    <Mail className="text-[#ff6188] animate-pulse" size={22} />
                                    <span className="text-[#ff6188]">Batch Emailer</span>
                                    <span
                                        onClick={() => setModals(prev => ({ ...prev, changelog: true }))}
                                        className="text-[10px] font-mono text-[#ab9df2] bg-[#ab9df2]/10 border border-[#ab9df2]/20 px-1.5 py-0.5 rounded cursor-pointer hover:bg-[#ab9df2]/20 hover:text-white transition-colors"
                                        title="View Changelog"
                                    >
                                        v1.3
                                    </span>
                                </span>
                                {currentClass && (
                                    <span className={`hidden md:inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold ${themeClasses.badgeBg}`}>
                                        <Book size={12} className="text-[#ab9df2]" /> {currentClass.name}
                                    </span>
                                )}
                            </div>
                            <div className="flex items-center gap-3 mt-0.5">
                                <span className="text-xs font-semibold text-[#a9dc76] select-none">
                                    &gt; Jonathan Kung
                                </span>
                                <a
                                    href="https://ko-fi.com/coolpuddytat"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    title="Buy me a coffee!"
                                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold bg-[#a9dc76]/10 border border-[#a9dc76]/30 text-[#a9dc76] hover:bg-[#a9dc76]/20 transition-all select-none"
                                >
                                    <Coffee size={10} className="text-[#a9dc76]" />
                                    <span>Ko-fi</span>
                                </a>
                            </div>
                        </div>
                    </div>

                    {/* Header Controls: Sync + Theme */}
                    <div className="flex items-center gap-2">
                        {/* Auto Sync Button */}
                        <button
                            id="auto-sync-btn"
                            onClick={autoSync}
                            disabled={syncStatus === 'syncing'}
                            className={`relative inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border transition-all duration-200 active:scale-95 ${
                                syncStatus === 'syncing'
                                    ? 'opacity-70 cursor-not-allowed border-[#4a474a] text-[#78dce8]'
                                    : syncStatus === 'external-update'
                                    ? 'border-[#78dce8] text-[#78dce8] bg-[#78dce8]/10 hover:bg-[#78dce8]/20 shadow-sm shadow-[#78dce8]/10'
                                    : syncStatus === 'local-changes'
                                    ? 'border-[#fc9867] text-[#fc9867] bg-[#fc9867]/10 hover:bg-[#fc9867]/20 shadow-sm shadow-[#fc9867]/10'
                                    : syncStatus === 'synced'
                                    ? isDark
                                        ? 'border-[#4a474a] bg-[#3a373a] text-[#a9dc76] hover:bg-[#4a474a]'
                                        : 'border-[#e1d5e3] bg-white text-[#22c55e] hover:bg-gray-50 shadow-sm'
                                    : isDark
                                    ? 'border-[#4a474a] bg-[#3a373a] text-zinc-400 hover:bg-[#4a474a] hover:text-zinc-200'
                                    : 'border-[#e1d5e3] bg-white text-zinc-500 hover:bg-gray-50 hover:text-zinc-700 shadow-sm'
                            }`}
                            title={
                                syncStatus === 'syncing'
                                    ? 'Syncing in progress…'
                                    : syncStatus === 'external-update'
                                    ? 'External updates available! Click to sync.'
                                    : syncStatus === 'local-changes'
                                    ? 'Unsynced local changes. Click to sync.'
                                    : syncStatus === 'synced'
                                    ? `Connected & synced (${syncFileName || 'sync file'}). Click to sync.`
                                    : 'Connect a sync file (1-click sync across devices)'
                            }
                        >
                            <RefreshCw
                                size={14}
                                className={`transition-transform duration-500 ${syncStatus === 'syncing' ? 'animate-spin' : ''}`}
                            />
                            <span className="hidden sm:inline font-medium">Sync</span>
                            {syncStatus === 'local-changes' && (
                                <span className="relative flex h-2 w-2 ml-0.5">
                                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#fc9867] opacity-75"></span>
                                    <span className="relative inline-flex rounded-full h-2 w-2 bg-[#fc9867]"></span>
                                </span>
                            )}
                            {syncStatus === 'external-update' && (
                                <span className="relative flex h-2 w-2 ml-0.5">
                                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#78dce8] opacity-75"></span>
                                    <span className="relative inline-flex rounded-full h-2 w-2 bg-[#78dce8]"></span>
                                </span>
                            )}
                        </button>

                        {/* Theme Selector Widget */}
                        <button
                            onClick={() => setTheme(isDark ? 'light' : 'dark')}
                            className={`p-2 rounded-xl transition-all duration-300 border active:scale-90 flex items-center justify-center ${isDark
                                ? 'bg-[#3a373a] border-[#4a474a] text-[#ff6188] hover:bg-[#4a474a]'
                                : 'bg-white border-[#e1d5e3] text-[#e0466a] hover:bg-gray-50 shadow-sm'
                                }`}
                            title={isDark ? "Switch to light theme" : "Switch to dark theme"}
                        >
                            {isDark ? <Sun size={18} className="animate-spin-slow text-[#ff6188]" /> : <Moon size={18} />}
                        </button>
                    </div>
                </div>

                {/* External Update Banner */}
                {externalBanner && (
                    <div className={`px-4 py-2 text-xs font-semibold flex items-center justify-between border-b transition-all duration-300 ${
                        isDark
                            ? 'bg-[#78dce8]/10 border-[#78dce8]/30 text-[#78dce8]'
                            : 'bg-[#e8f4f7] border-[#78dce8]/50 text-[#13677a]'
                    }`}>
                        <div className="flex items-center gap-2 truncate mr-2">
                            <RefreshCw size={14} className="text-[#78dce8] shrink-0" />
                            <span className="truncate">{externalBanner}</span>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                            <button
                                onClick={autoSync}
                                className="px-2.5 py-1 rounded-md text-xs font-bold bg-[#78dce8] text-[#221f22] hover:bg-[#6bd0dc] transition-all active:scale-95 shadow-xs"
                            >
                                Sync Now
                            </button>
                            <button
                                onClick={() => setExternalBanner(null)}
                                className="p-1 rounded-md hover:bg-black/10 transition-colors"
                                title="Dismiss"
                            >
                                <X size={14} />
                            </button>
                        </div>
                    </div>
                )}

                {activeClassId ? (
                    <div className="flex-1 flex flex-col h-full overflow-hidden p-4 md:p-8">
                        <div className="flex flex-col xl:flex-row xl:items-end justify-between gap-4 mb-6">
                            <div>
                                <h1 className="text-2xl md:text-3xl font-bold tracking-tight">
                                    {currentClass?.name}
                                </h1>
                                <p className={`mt-1 text-sm md:text-base font-semibold ${themeClasses.textMuted}`}>
                                    {classStudents.length} Contacts | {selectedStudents.length} Selected
                                </p>
                            </div>

                            {/* Responsive action group wrapper */}
                            <div className="flex flex-wrap gap-2 items-center">
                                <button onClick={() => setModals({ ...modals, bulkAdd: true })} className={`px-3 md:px-4 py-2 rounded-lg font-medium flex items-center gap-2 shadow-sm text-sm transition-all active:scale-95 ${themeClasses.btnSecondary}`}>
                                    <Upload size={16} className="text-[#78dce8]" /> Import Contacts
                                </button>
                                <button onClick={() => { setEditingItem(null); openEditModal('student', null); }} className={`px-3 md:px-4 py-2 rounded-lg font-medium flex items-center gap-2 shadow-sm text-sm transition-all active:scale-95 ${themeClasses.btnSecondary}`}>
                                    <Plus size={16} className="text-[#a9dc76]" /> Add Contact
                                </button>
                                <button
                                    onClick={() => selectedStudents.length > 0 ? setModals({ ...modals, draftEmail: true }) : showAlert("No Contacts Selected", "Select contacts first.")}
                                    className={`px-3 md:px-4 py-2 rounded-lg font-semibold flex items-center gap-2 shadow-sm transition-all active:scale-95 text-sm ${selectedStudents.length > 0 ? themeClasses.btnPrimary : 'bg-gray-200 text-gray-400 cursor-not-allowed border border-transparent shadow-none'
                                        }`}
                                >
                                    <Mail size={16} /> Draft Email ({selectedStudents.length})
                                </button>
                                {/* Print & Save PDF Buttons positioned at the end on the right */}
                                <div className="flex gap-2 ml-auto xl:ml-0">
                                    <button onClick={handlePrintPDF} className={`px-3 md:px-4 py-2 rounded-lg font-medium flex items-center gap-2 shadow-sm text-sm transition-all active:scale-95 ${themeClasses.btnSecondary}`} title="Print report to a printer">
                                        <Printer size={16} className="text-[#fc9867]" /> Print
                                    </button>
                                    <button onClick={handleSavePDF} className={`px-3 md:px-4 py-2 rounded-lg font-medium flex items-center gap-2 shadow-sm text-sm transition-all active:scale-95 ${themeClasses.btnSecondary}`} title="Save report as a PDF file">
                                        <Download size={16} className="text-[#ab9df2]" /> Save PDF
                                    </button>
                                </div>
                            </div>
                        </div>

                        {/* Table Controls */}
                        <div className={`flex justify-between items-center mb-3 p-3 rounded-lg border shadow-sm flex-wrap gap-2 transition-colors duration-300 ${themeClasses.cardBg}`}>
                            <div className="flex gap-2">
                                <button onClick={toggleSelectAll} className={`flex items-center gap-2 px-3 py-1.5 text-sm font-semibold rounded-md transition-colors ${isDark ? 'hover:bg-[#4a474a]/50 text-gray-250' : 'hover:bg-gray-150 text-gray-750'}`}>
                                    {allSelected ? <CheckSquare size={18} className="text-[#ff6188]" /> : <Square size={18} className="text-gray-400" />}
                                    {allSelected ? 'Deselect All' : 'Select All'}
                                </button>
                            </div>
                            <div className="flex gap-2 flex-wrap">
                                <button
                                    onClick={() => selectedStudents.length > 0 && deleteStudents(selectedStudents)}
                                    className={`text-sm px-3 py-1.5 rounded-md flex items-center gap-2 transition-all active:scale-95 ${selectedStudents.length > 0
                                        ? themeClasses.btnDanger
                                        : 'text-gray-400 cursor-not-allowed opacity-50 shadow-none border-transparent bg-transparent'
                                        }`}
                                    disabled={selectedStudents.length === 0}
                                    title="Delete every selected contact"
                                >
                                    <Trash2 size={16} /> Delete Selected ({selectedStudents.length})
                                </button>
                                <button
                                    onClick={clearHistory}
                                    className={`text-sm px-3 py-1.5 rounded-md flex items-center gap-2 transition-all active:scale-95 ${selectedStudents.length > 0
                                        ? themeClasses.btnDanger
                                        : 'text-gray-400 cursor-not-allowed opacity-50 shadow-none border-transparent bg-transparent'
                                        }`}
                                    disabled={selectedStudents.length === 0}
                                >
                                    <Trash2 size={16} /> Clear Selected Logs
                                </button>
                            </div>
                        </div>

                        {/* Responsive scrolling table wrapper */}
                        <div className={`border rounded-xl flex-1 overflow-auto shadow-sm transition-colors duration-300 ${themeClasses.cardBg}`}>
                            <table className="w-full text-left border-collapse min-w-[800px]">
                                <thead className={`sticky top-0 z-10 text-xs font-bold uppercase tracking-wider ${themeClasses.tableHeaderBg}`}>
                                    <tr>
                                        <th className="p-3 w-12 text-center"><Check size={18} className="mx-auto text-gray-455" /></th>
                                        <th className="p-3 w-px whitespace-nowrap">Name</th>
                                        <th className="p-3 w-px whitespace-nowrap">Emails</th>
                                        <th className="p-3 w-px whitespace-nowrap">Most Recent Email</th>
                                        <th className="p-3">Message Snippet</th>
                                        <th className="p-3">Notes</th>
                                        <th className="p-3 w-24 text-center"></th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-gray-200/10">
                                    {classStudents.length === 0 ? (
                                        <tr>
                                            <td colSpan="7" className="p-10 text-center">
                                                <div className="flex flex-col items-center gap-3">
                                                    <FileText size={48} className="text-gray-300 animate-bounce" />
                                                    <p className={`font-semibold ${themeClasses.textMuted}`}>No contacts in this group.</p>
                                                    <p className="text-xs text-gray-400">Click "Add Contact" or "Import Contacts" to begin.</p>
                                                </div>
                                            </td>
                                        </tr>
                                    ) : classStudents.map(student => {
                                        const isSelected = selectedStudents.includes(student.id);
                                        const allEmails = student.emails || [];
                                        const cleanEmails = allEmails.filter(Boolean);
                                        const missingEmail = cleanEmails.length === 0;

                                        const historyCount = student.emailHistory?.length || 0;
                                        const isHistoryExpanded = expandedStudents.includes(student.id);
                                        const lastLog = student.emailHistory?.[0] || null;

                                        const isEmailsExpanded = expandedEmailContacts.includes(student.id);

                                        return (
                                            <React.Fragment key={student.id}>
                                                {/* Main Contact Row */}
                                                <tr
                                                    className={`transition-all duration-200 cursor-pointer select-none ${isSelected ? themeClasses.selectedRowBg : themeClasses.altRowBg}`}
                                                    onClick={(e) => handleStudentClick(e, student.id)}
                                                    onDoubleClick={() => openEditModal('student', student)}
                                                    onContextMenu={(e) => openContactContextMenu(e, student.id)}
                                                >
                                                    <td className="p-3 text-center">
                                                        <input
                                                            type="checkbox"
                                                            checked={isSelected}
                                                            onChange={() => { }} // Controlled via onClick below
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                setLastSelectedStudentId(student.id);
                                                                toggleStudentSelection(student.id);
                                                            }}
                                                            className="w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500 cursor-pointer transition-all active:scale-90"
                                                        />
                                                    </td>
                                                    <td className="p-3 text-sm whitespace-nowrap">
                                                        <div className={`font-bold transition-colors duration-300 ${themeClasses.textPrimary}`}>{student.name}</div>
                                                        {historyCount > 0 && (
                                                            <button
                                                                onClick={() => toggleStudentHistory(student.id)}
                                                                className={`inline-flex items-center gap-1.5 text-[11px] font-bold mt-1.5 px-2.5 py-0.5 rounded-full transition-all active:scale-95 shadow-sm ${isDark ? 'bg-[#ab9df2]/15 text-[#ab9df2] hover:bg-[#ab9df2]/25' : 'bg-[#ab9df2]/20 text-[#5c4cb0] hover:bg-[#ab9df2]/30'
                                                                    }`}
                                                            >
                                                                <History size={12} />
                                                                {isHistoryExpanded ? 'Hide History' : `Show History (${historyCount})`}
                                                                {isHistoryExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                                                            </button>
                                                        )}
                                                    </td>
                                                    <td className="p-3 text-sm whitespace-nowrap">
                                                        <div className="flex flex-col gap-1 max-w-xs">
                                                            {missingEmail ? (
                                                                <div className="px-2 py-1 rounded bg-[#ff6188]/20 text-[#ff6188] border border-[#ff6188]/30 text-xs font-bold flex items-center gap-1 inline-block self-start shadow-sm animate-pulse">
                                                                    <AlertCircle size={12} /> Missing
                                                                </div>
                                                            ) : (
                                                                <>
                                                                    {/* Renders first two emails, remaining are accessible via inline accordion toggle */}
                                                                    {cleanEmails.slice(0, 2).map((email, idx) => (
                                                                        <div key={idx} className={`truncate px-2 py-0.5 rounded text-xs select-all inline-block border font-bold max-w-[200px] ${isDark ? 'bg-zinc-800 text-zinc-300 border-zinc-700' : 'bg-[#f2ece0]/50 text-gray-750 border-gray-350'
                                                                            }`} title={email}>
                                                                            {email}
                                                                        </div>
                                                                    ))}

                                                                    {cleanEmails.length > 2 && (
                                                                        <>
                                                                            {isEmailsExpanded && cleanEmails.slice(2).map((email, idx) => (
                                                                                <div key={idx + 2} className={`truncate px-2 py-0.5 rounded text-xs select-all inline-block border font-bold max-w-[200px] ${isDark ? 'bg-zinc-800 text-zinc-300 border-zinc-700' : 'bg-[#f2ece0]/50 text-gray-750 border-gray-350'
                                                                                    }`} title={email}>
                                                                                    {email}
                                                                                </div>
                                                                            ))}

                                                                            <button
                                                                                type="button"
                                                                                onClick={(e) => toggleEmailsExpanded(student.id, e)}
                                                                                className={`text-xs font-bold hover:underline text-left mt-0.5 ${isDark ? 'text-[#78dce8] hover:text-[#97e5ef]' : 'text-[#ff6188] hover:text-[#ff80a2]'}`}
                                                                            >
                                                                                {isEmailsExpanded ? 'Hide remaining' : `+${cleanEmails.length - 2} more`}
                                                                            </button>
                                                                        </>
                                                                    )}
                                                                </>
                                                            )}
                                                        </div>
                                                    </td>
                                                    <td className={`p-3 text-xs font-semibold whitespace-nowrap transition-colors duration-300 ${themeClasses.textSecondary}`}>
                                                        {lastLog ? formatDate(lastLog.timestamp) : <span className="text-gray-300 italic">Never emailed</span>}
                                                    </td>
                                                    <td className={`p-3 text-xs truncate max-w-[400px] font-semibold transition-colors duration-300 ${themeClasses.textSecondary}`} title={lastLog?.message || ''}>
                                                        {lastLog ? lastLog.message : ''}
                                                    </td>
                                                    <td className={`p-3 text-xs truncate max-w-[300px] font-semibold transition-colors duration-300 ${themeClasses.textSecondary}`} title={student.notes || ''}>
                                                        {student.notes || <span className="text-gray-300 italic">-</span>}
                                                    </td>
                                                    <td className="p-3 text-center">
                                                        <div className="flex items-center justify-center gap-1.5">
                                                            <button onClick={() => openEditModal('student', student)} title="Edit contact" className={`p-1.5 rounded-lg border transition-all duration-200 active:scale-95 ${isDark ? 'text-zinc-400 hover:text-[#78dce8] hover:bg-zinc-800 border-zinc-700' : 'text-gray-500 hover:text-[#00838f] hover:bg-gray-100 border-gray-200'
                                                                }`}><Edit2 size={16} /></button>
                                                            <button onClick={() => deleteStudent(student.id)} title="Delete contact" className={`p-1.5 rounded-lg border transition-all duration-200 active:scale-95 ${isDark ? 'text-zinc-400 hover:text-[#ff6188] hover:bg-zinc-800 border-zinc-700' : 'text-gray-500 hover:text-[#ff6188] hover:bg-gray-100 border-gray-200'
                                                                }`}><Trash2 size={16} /></button>
                                                        </div>
                                                    </td>
                                                </tr>

                                                {/* Expandable History Detail Row */}
                                                {isHistoryExpanded && historyCount > 0 && (
                                                    <tr className="animate-in fade-in slide-in-from-top-1 duration-200">
                                                        <td colSpan="7" className={`p-4 border-t border-b transition-colors duration-300 ${isDark ? 'bg-[#221f22]/60 border-[#4a474a]/50' : 'bg-[#e1d5e3]/15 border-[#e1d5e3]/60'}`}>
                                                            <div className="pl-4 md:pl-12 pr-2 md:pr-6">
                                                                <h4 className={`text-xs font-extrabold uppercase tracking-wider mb-3 flex items-center gap-1.5 ${isDark ? 'text-[#ab9df2]' : 'text-[#5c4cb0]'}`}>
                                                                    <Clock size={12} /> Communication Log for {student.name}
                                                                </h4>
                                                                <div className="space-y-3 max-h-60 overflow-y-auto pr-2">
                                                                    {student.emailHistory.map((log, index) => (
                                                                        <div key={log.id || index} className={`border rounded-xl p-3 shadow-xs relative group/log transition-all duration-300 hover:shadow-sm ${isDark ? 'bg-[#3a373a] border-[#4a474a]' : 'bg-white border-[#e1d5e3]'
                                                                            }`}>
                                                                            <div className="flex justify-between items-start mb-1 text-xs text-gray-400">
                                                                                <span className={`font-bold ${isDark ? 'text-[#939293]' : 'text-[#726f73]'}`}>{formatDate(log.timestamp)}</span>
                                                                                <div className="flex items-center gap-2">
                                                                                    {index === 0 && <span className={`text-[10px] font-bold border px-2 py-0.5 rounded-full ${isDark ? 'bg-[#a9dc76]/10 text-[#a9dc76] border-[#a9dc76]/30' : 'bg-[#3f7a1a]/10 text-[#3f7a1a] border-[#3f7a1a]/20'}`}>Latest</span>}
                                                                                    <button
                                                                                        onClick={() => deleteHistoryEntry(student.id, log.id)}
                                                                                        className="opacity-0 group-hover/log:opacity-100 text-[#ff6188] hover:text-[#ff3864] p-0.5 rounded transition-opacity"
                                                                                        title="Delete log entry"
                                                                                    >
                                                                                        <Trash2 size={13} />
                                                                                    </button>
                                                                                </div>
                                                                            </div>
                                                                            {log.subject && (
                                                                                <p className={`text-sm font-bold mb-1 select-all transition-colors duration-300 ${isDark ? 'text-[#78dce8]' : 'text-[#00838f]'}`}>
                                                                                    Subject: {log.subject}
                                                                                </p>
                                                                            )}
                                                                            <p className={`text-sm whitespace-pre-wrap leading-relaxed select-all transition-colors duration-300 ${themeClasses.textPrimary}`}>
                                                                                {log.message}
                                                                            </p>
                                                                        </div>
                                                                    ))}
                                                                </div>
                                                            </div>
                                                        </td>
                                                    </tr>
                                                )}
                                            </React.Fragment>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </div>
                ) : (
                    <div className="flex-1 flex items-center justify-center p-4">
                        <div className={`text-center max-w-md p-6 md:p-8 rounded-xl shadow-sm border transition-all duration-300 hover:shadow-md ${themeClasses.cardBg}`}>
                            <Mail size={48} className="mx-auto text-[#ff6188] mb-4 animate-pulse" />
                            <h2 className="text-2xl font-bold mb-2">Welcome to Batch Emailer</h2>
                            <p className={`mb-6 text-sm md:text-base ${themeClasses.textMuted}`}>Privacy-compliant email drafting. Select a group from the sidebar or create a new one to start managing your contact lists safely.</p>
                            <button
                                onClick={() => {
                                    if (activeFolders.length === 0) setModals({ ...modals, folder: true });
                                    else setModals({ ...modals, class: true });
                                }}
                                className={`px-6 py-2 rounded-lg font-medium transition-colors ${themeClasses.btnPrimary}`}
                            >
                                {activeFolders.length === 0 ? "Create First Folder" : "Create New Group"}
                            </button>
                        </div>
                    </div>
                )}
            </div>

            {/* --- MODALS --- */}

            {/* Folder Modal - Rose Pink Header Accent */}
            {modals.folder && (
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 backdrop-blur-xs">
                    <div className={`rounded-2xl shadow-xl w-full max-w-md overflow-hidden border animate-in fade-in zoom-in-95 duration-200 ${themeClasses.cardBg}`}>
                        <div className="p-4 border-b flex justify-between items-center bg-gray-50/5">
                            <h3 className={`font-bold text-lg ${isDark ? 'text-[#ff6188]' : 'text-[#e0466a]'}`}>{editingItem ? 'Edit Folder' : 'New Folder'}</h3>
                            <button onClick={closeModals} className="text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-500/10 transition-colors"><X size={20} /></button>
                        </div>
                        <form onSubmit={saveFolder} className="p-4 space-y-4">
                            <div>
                                <label className={`block text-xs font-bold uppercase tracking-wider mb-1.5 ${isDark ? 'text-[#ff6188]/70' : 'text-[#e0466a]/70'}`}>Folder Name</label>
                                <input required autoFocus type="text" name="name" defaultValue={editingItem?.name || ''} className={`w-full border rounded-xl p-2.5 outline-none transition-all font-medium text-sm ${themeClasses.inputBg}`} placeholder="e.g., 2026-2027 School Year" />
                            </div>
                            <div className="flex justify-end gap-2 pt-2">
                                <button type="button" onClick={closeModals} className={`px-4 py-2 rounded-lg text-xs font-bold transition-all ${themeClasses.btnSecondary}`}>Cancel</button>
                                <button type="submit" className={`px-4 py-2 rounded-lg text-xs font-bold transition-all ${themeClasses.btnPrimary}`}>Save</button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* Class/Group Modal - Orchid Purple Header Accent */}
            {modals.class && (
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 backdrop-blur-xs">
                    <div className={`rounded-2xl shadow-xl w-full max-w-md overflow-hidden border animate-in fade-in zoom-in-95 duration-200 ${themeClasses.cardBg}`}>
                        <div className="p-4 border-b flex justify-between items-center bg-gray-50/5">
                            <h3 className={`font-bold text-lg ${isDark ? 'text-[#ab9df2]' : 'text-[#5c4cb0]'}`}>{editingItem ? 'Edit Group' : 'New Group'}</h3>
                            <button onClick={closeModals} className="text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-500/10 transition-colors"><X size={20} /></button>
                        </div>
                        <form onSubmit={saveClass} className="p-4 space-y-4">
                            <div>
                                <label className={`block text-xs font-bold uppercase tracking-wider mb-1.5 ${isDark ? 'text-[#ab9df2]/70' : 'text-[#5c4cb0]/70'}`}>Parent Folder</label>
                                <select required name="folderId" defaultValue={editingItem?.folderId || activeFolderId || ''} className={`w-full border rounded-xl p-2.5 outline-none transition-all font-medium text-sm ${themeClasses.inputBg}`}>
                                    <option value="" disabled className="text-gray-400">Select a folder</option>
                                    {data.folders.filter(f => !f.isArchived).map(f => (
                                        <option key={f.id} value={f.id} className="text-gray-800 dark:text-white dark:bg-[#3a373a]">{f.name}</option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label className={`block text-xs font-bold uppercase tracking-wider mb-1.5 ${isDark ? 'text-[#ab9df2]/70' : 'text-[#5c4cb0]/70'}`}>Group Name</label>
                                <input required autoFocus type="text" name="name" defaultValue={editingItem?.name || ''} className={`w-full border rounded-xl p-2.5 outline-none transition-all font-medium text-sm ${themeClasses.inputBg}`} placeholder="e.g., Block A - Science 10" />
                            </div>
                            <div className="flex justify-end gap-2 pt-2">
                                <button type="button" onClick={closeModals} className={`px-4 py-2 rounded-lg text-xs font-bold transition-all ${themeClasses.btnSecondary}`}>Cancel</button>
                                <button type="submit" className={`px-4 py-2 rounded-lg text-xs font-bold transition-all ${themeClasses.btnPrimary}`}>Save</button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* Contact Modal - Mint Green Header Accent */}
            {modals.student && (
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 backdrop-blur-xs">
                    <div className={`rounded-2xl shadow-xl w-full max-w-lg overflow-hidden border animate-in fade-in zoom-in-95 duration-200 ${themeClasses.cardBg}`}>
                        <div className="p-4 border-b flex justify-between items-center bg-gray-50/5">
                            <h3 className={`font-bold text-lg ${isDark ? 'text-[#a9dc76]' : 'text-[#3f7a1a]'}`}>{editingItem ? 'Edit Contact' : 'Add Contact'}</h3>
                            <button onClick={closeModals} className="text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-500/10 transition-colors"><X size={20} /></button>
                        </div>
                        <form onSubmit={saveStudent} className="p-4 space-y-4 max-h-[80vh] overflow-y-auto">
                            <div>
                                <label className={`block text-xs font-bold uppercase tracking-wider mb-1.5 ${isDark ? 'text-[#a9dc76]/70' : 'text-[#3f7a1a]/70'}`}>Contact Name</label>
                                <input required autoFocus type="text" name="name" defaultValue={editingItem?.name || ''} className={`w-full border rounded-xl p-2.5 outline-none transition-all font-medium text-sm ${themeClasses.inputBg}`} placeholder="e.g., Alex Smith (Student)" />
                            </div>

                            {/* Dynamic Emails Field List */}
                            <div className="space-y-2">
                                <div className="flex justify-between items-center">
                                    <label className="block text-sm font-medium dark:text-gray-300">Email Addresses</label>
                                    <button
                                        type="button"
                                        onClick={handleAddEmailField}
                                        className={`text-xs font-bold flex items-center gap-1 transition-colors ${isDark ? 'text-[#78dce8] hover:text-[#97e5ef]' : 'text-blue-600 hover:text-blue-800'}`}
                                    >
                                        <Plus size={14} /> Add Email
                                    </button>
                                </div>
                                {modalEmails.map((email, idx) => (
                                    <div key={idx} className="flex gap-2 items-center">
                                        <input
                                            type="email"
                                            value={email}
                                            onChange={(e) => handleEmailValueChange(idx, e.target.value)}
                                            className={`flex-1 border rounded-xl p-2.5 outline-none transition-all font-medium text-sm ${themeClasses.inputBg}`}
                                            placeholder={`Parent Email ${idx + 1}`}
                                        />
                                        <button
                                            type="button"
                                            onClick={() => handleRemoveEmailField(idx)}
                                            className="p-2.5 text-gray-400 hover:text-red-500 rounded-xl border border-transparent hover:border-red-200 hover:bg-red-500/10 transition-all active:scale-90"
                                            title="Remove address"
                                        >
                                            <Trash size={16} />
                                        </button>
                                    </div>
                                ))}
                            </div>

                            <div>
                                <label className={`block text-xs font-bold uppercase tracking-wider mb-1.5 ${isDark ? 'text-[#a9dc76]/70' : 'text-[#3f7a1a]/70'}`}>Notes</label>
                                <textarea name="notes" defaultValue={editingItem?.notes || ''} rows="2" className={`w-full border rounded-xl p-2.5 outline-none transition-all font-medium text-sm ${themeClasses.inputBg}`} placeholder="e.g., Mother: Sarah Smith (sarah@example.com)"></textarea>
                            </div>
                            <div className="flex justify-between pt-2 items-center">
                                {editingItem ? (
                                    <button type="button" onClick={() => deleteStudent(editingItem.id)} className="text-[#ff6188] hover:text-[#ff3864] text-sm hover:underline font-bold">Delete Contact</button>
                                ) : <div></div>}
                                <div className="flex gap-2">
                                    <button type="button" onClick={closeModals} className={`px-4 py-2 rounded-lg text-xs font-bold transition-all ${themeClasses.btnSecondary}`}>Cancel</button>
                                    <button type="submit" className={`px-4 py-2 rounded-lg text-xs font-bold transition-all ${themeClasses.btnPrimary}`}>Save</button>
                                </div>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* Unified Import Contacts Modal (CSV + Paste) */}
            {modals.bulkAdd && (
                <ImportContactsModal
                    onImportContacts={handleBulkAdd}
                    existingStudents={data.students}
                    closeModal={closeModals}
                    themeClasses={themeClasses}
                />
            )}

            {/* Sync & Backup Modal */}
            {modals.backup && (
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 backdrop-blur-xs">
                    <div className={`rounded-2xl shadow-xl w-full max-w-md overflow-hidden border animate-in fade-in zoom-in-95 duration-200 ${themeClasses.cardBg}`}>
                        <div className="p-4 border-b flex justify-between items-center bg-gray-50/5">
                            <h3 className={`font-bold text-lg ${isDark ? 'text-[#78dce8]' : 'text-[#13677a]'}`}>Sync & Backup</h3>
                            <button onClick={closeModals} className="text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-500/10 transition-colors"><X size={20} /></button>
                        </div>
                        <div className="p-5 space-y-4 max-h-[80vh] overflow-y-auto">

                            {/* Sync Section */}
                            <div className={`border rounded-xl p-4 text-left space-y-3 shadow-xs bg-gray-50/5 ${themeClasses.border}`}>
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                        <RefreshCw size={20} className={`${isDark ? 'text-[#78dce8]' : 'text-[#2188a0]'} ${syncStatus === 'syncing' ? 'animate-spin' : ''}`} />
                                        <h4 className="font-semibold text-sm">File Sync</h4>
                                    </div>
                                    {syncStatus === 'synced' && (
                                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full flex items-center gap-1 bg-emerald-500/15 text-emerald-500`}>
                                            <CheckCircle2 size={11} /> In Sync
                                        </span>
                                    )}
                                    {syncStatus === 'local-changes' && (
                                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full flex items-center gap-1 bg-amber-500/15 text-amber-500`}>
                                            <AlertTriangle size={11} /> Local Changes
                                        </span>
                                    )}
                                    {syncStatus === 'external-update' && (
                                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full flex items-center gap-1 bg-cyan-500/15 text-cyan-400`}>
                                            <RefreshCw size={11} className="animate-spin" /> External Update
                                        </span>
                                    )}
                                    {syncStatus === 'error' && (
                                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full flex items-center gap-1 bg-rose-500/15 text-rose-500`}>
                                            <AlertTriangle size={11} /> Error
                                        </span>
                                    )}
                                    {syncStatus === 'idle' && (
                                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${isDark ? 'bg-gray-600/30 text-gray-400' : 'bg-gray-200 text-gray-500'}`}>
                                            Not Connected
                                        </span>
                                    )}
                                </div>
                                <p className="text-xs text-gray-500 dark:text-gray-400 font-medium">
                                    {window.showOpenFilePicker
                                        ? 'Chrome/Arc/Edge: Connects to a file on disk. Sync reads and writes automatically on each click.'
                                        : 'Safari/Firefox: Select a sync file each time you sync. Changes are saved as a new download.'
                                    }
                                </p>
                                {syncFileName && (
                                    <div className={`px-3 py-2 rounded-lg text-[11px] font-mono flex items-center gap-2 ${isDark ? 'bg-[#221f22] text-[#78dce8]' : 'bg-[#e8f4f7] text-[#13677a]'}`}>
                                        <FileText size={12} className="flex-shrink-0" />
                                        <span className="truncate">{syncFileName}</span>
                                    </div>
                                )}
                                <div className="flex flex-wrap gap-2">
                                    <button
                                        onClick={() => { autoSync(); setModals({ ...modals, backup: false }); }}
                                        disabled={syncStatus === 'syncing'}
                                        className={`flex-1 min-w-[120px] py-2.5 rounded-lg text-xs font-bold transition-all active:scale-95 flex items-center justify-center gap-1.5 ${syncStatus === 'syncing' ? 'opacity-50 cursor-not-allowed' : ''} ${themeClasses.btnPrimary}`}
                                    >
                                        <RefreshCw size={13} className={syncStatus === 'syncing' ? 'animate-spin' : ''} />
                                        {syncStatus === 'syncing' ? 'Syncing…' : 'Sync Now'}
                                    </button>
                                    {syncFileName && (
                                        <button
                                            onClick={handleChangeSyncFile}
                                            className={`py-2.5 px-3 rounded-lg text-xs font-bold transition-all active:scale-95 flex items-center gap-1 ${themeClasses.btnSecondary}`}
                                            title="Choose a different sync file"
                                        >
                                            <FolderOpen size={13} /> Change
                                        </button>
                                    )}
                                    {syncFileName && (
                                        <button
                                            onClick={handleDisconnectSync}
                                            className={`py-2.5 px-3 rounded-lg text-xs font-bold transition-all active:scale-95 flex items-center gap-1 ${isDark ? 'bg-rose-500/10 text-rose-400 hover:bg-rose-500/20' : 'bg-rose-50 text-rose-600 hover:bg-rose-100'}`}
                                            title="Disconnect sync file"
                                        >
                                            <CloudOff size={13} /> Disconnect
                                        </button>
                                    )}
                                </div>
                                {getSyncMeta().lastSyncedAt && (
                                    <p className="text-[10px] text-gray-500 dark:text-gray-500">
                                        Last synced: {new Date(getSyncMeta().lastSyncedAt).toLocaleString()}
                                    </p>
                                )}
                            </div>

                            {/* Export Backup Section */}
                            <div className={`border rounded-xl p-4 text-left space-y-3 shadow-xs bg-gray-50/5 ${themeClasses.border}`}>
                                <div className="flex items-center gap-2">
                                    <Download size={20} className="text-blue-500" />
                                    <h4 className="font-semibold text-sm">Download Backup</h4>
                                </div>
                                <p className="text-xs text-gray-500 dark:text-gray-400 font-medium">
                                    Saves an encrypted backup file to your device — every folder, group, contact, note, email message and setting is included, and the file is read back and verified before it is saved. Can be used as a sync file — interchangeable formats.
                                </p>
                                <p className={`text-[11px] font-bold ${isDark ? 'text-[#a9dc76]' : 'text-[#3f7a1a]'}`}>
                                    Currently backed up: {describeDataSummary(data)}
                                </p>
                                <button onClick={handleExportBackup} className={`w-full py-2.5 rounded-lg text-xs font-bold transition-all active:scale-95 ${themeClasses.btnPrimary}`}>
                                    <span className="flex items-center justify-center gap-2"><Download size={14} /> Download Encrypted Backup</span>
                                </button>
                            </div>

                            {/* Restore Section */}
                            <div className={`border rounded-xl p-4 text-left space-y-3 shadow-xs bg-gray-50/5 ${themeClasses.border}`}>
                                <div className="flex items-center gap-2">
                                    <Upload size={20} className="text-emerald-500" />
                                    <h4 className="font-semibold text-sm">Restore from Backup</h4>
                                </div>
                                <p className="text-xs text-gray-500 dark:text-gray-400 font-medium">
                                    Load a backup or sync file. You'll choose whether to replace all data or merge the file into what you have — merging keeps your contacts and adds any folders, groups and email messages you don't have yet.
                                </p>
                                <label className={`w-full py-2.5 rounded-lg text-xs font-bold transition-all active:scale-95 cursor-pointer flex items-center justify-center gap-2 ${themeClasses.btnSecondary}`}>
                                    <Upload size={14} /> Select Backup File
                                    <input
                                        type="file"
                                        accept=".json"
                                        className="hidden"
                                        onChange={restoreFromBackup}
                                    />
                                </label>
                            </div>

                        </div>
                    </div>
                </div>
            )}

            {/* Changelog Modal */}
            {modals.changelog && (
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 backdrop-blur-xs">
                    <div className={`rounded-2xl shadow-xl w-full max-w-md overflow-hidden border animate-in fade-in zoom-in-95 duration-200 ${themeClasses.cardBg}`}>
                        <div className="p-4 border-b flex justify-between items-center bg-gray-50/5">
                            <h3 className={`font-bold text-lg ${isDark ? 'text-[#ff6188]' : 'text-[#e0466a]'}`}>Changelog</h3>
                            <button onClick={closeModals} className="text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-500/10 transition-colors"><X size={20} /></button>
                        </div>
                        <div className="p-6 space-y-4">
                            <div className="space-y-2">
                                <div className="flex items-center justify-between">
                                    <span className="text-sm font-bold text-[#a9dc76]">v1.5</span>
                                    <span className="text-[10px] text-gray-500 font-mono">2026-09-28</span>
                                </div>
                                <ul className="list-disc pl-4 text-xs space-y-1 text-gray-600 dark:text-gray-400">
                                    <li>Contact importing accepts far more formats: Google Docs/Sheets tables (tab separated), comma separated rows, addresses wrapped as <code>Name &lt;email&gt;</code>, a name on one line with its emails on the next, several emails per row, header rows and blank lines.</li>
                                    <li>Every import now stops at a <strong>review step</strong>: the parsed rows appear in an editable table (name / emails / notes) where you can correct, delete or add rows, see which contacts you already have, and skip them before confirming.</li>
                                    <li>Backups and sync files are verified before they count as saved: the app decrypts the file it just wrote and confirms the folder, group, contact and email-message counts (and contents) still match — otherwise the save fails loudly instead of writing an incomplete file.</li>
                                    <li>The restore screen now shows how many <strong>email messages</strong> a file contains, and the confirmation after a download repeats the full contents of the backup.</li>
                                    <li>"Import New Items Only" now merges: contacts you already have absorb any email messages from the file instead of being skipped.</li>
                                    <li>Backup files now also carry your settings (theme), which are restored with "Replace All Data".</li>
                                    <li>Drafted emails store the subject line with each logged message, shown at the top of the contact's history.</li>
                                    <li>If your browser runs out of storage, the app now warns you instead of silently discarding your latest changes.</li>
                                    <li>Contacts can now be deleted: single delete from the row's trash button, the edit modal, or the right-click menu.</li>
                                    <li>Added "Delete Selected" for deleting many contacts at once, plus Delete-key support for the current selection.</li>
                                    <li>Right-click any contact row to open a context menu (Edit / Delete). Right-clicking an unselected contact selects it first; if multiple contacts are selected, the menu deletes all of them.</li>
                                    <li>Selection now follows standard conventions: click selects a single contact, Ctrl/Cmd+click toggles, Shift+click selects a range, and Ctrl/Cmd+Shift+click extends the selection.</li>
                                    <li>Every delete asks for confirmation before contacts are removed.</li>
                                </ul>
                            </div>
                            <div className="space-y-2">
                                <div className="flex items-center justify-between">
                                    <span className="text-sm font-bold text-[#a9dc76]">v1.3</span>
                                    <span className="text-[10px] text-gray-500 font-mono">2026-07-23</span>
                                </div>
                                <ul className="list-disc pl-4 text-xs space-y-1 text-gray-600 dark:text-gray-400">
                                    <li>FIPPA Compliance: Added AES-256 password-based Web Crypto encryption for exported backup files with password confirmation & recovery reminders.</li>
                                    <li>FIPPA Compliance: Added automatic background IndexedDB backups (`BatchEmailerDB`) for zero-friction data protection without UI lag.</li>
                                    <li>Support for importing both encrypted backups and legacy unencrypted JSON backup files.</li>
                                </ul>
                            </div>
                            <div className="space-y-2">
                                <div className="flex items-center justify-between">
                                    <span className="text-sm font-bold text-[#a9dc76]">v1.2</span>
                                    <span className="text-[10px] text-gray-500 font-mono">2026-06-30</span>
                                </div>
                                <ul className="list-disc pl-4 text-xs space-y-1 text-gray-600 dark:text-gray-400">
                                    <li>Added customizable Subject Line to the email draft modal.</li>
                                    <li>Split "Print Report" into separate "Print" and "Save PDF" actions.</li>
                                    <li>Optimized printed PDF layout with compact contact styling and 60% width allocation for email logs.</li>
                                </ul>
                            </div>
                            <div className="space-y-2">
                                <div className="flex items-center justify-between">
                                    <span className="text-sm font-bold text-[#a9dc76]">v1.1</span>
                                    <span className="text-[10px] text-gray-500 font-mono">2026-06-30</span>
                                </div>
                                <ul className="list-disc pl-4 text-xs space-y-1 text-gray-600 dark:text-gray-400">
                                    <li>Sidebar folders now animate open and closed with a smooth slide transition.</li>
                                    <li>Folder icons change between closed and open states to clearly indicate expand/collapse.</li>
                                    <li>Added rotating chevron indicator on each folder row.</li>
                                    <li>Added group count badge on each folder, visible at rest and hidden on hover for action buttons.</li>
                                    <li>Contact rows now toggle selection on click (Ctrl-like behavior by default) — select multiple contacts without holding modifier keys.</li>
                                    <li>Shift-click range selection now appends to the current selection.</li>
                                </ul>
                            </div>
                            <div className="space-y-2">
                                <div className="flex items-center justify-between">
                                    <span className="text-sm font-bold text-[#a9dc76]">v1.0</span>
                                    <span className="text-[10px] text-gray-500 font-mono">2026-06-30</span>
                                </div>
                                <ul className="list-disc pl-4 text-xs space-y-1 text-gray-600 dark:text-gray-400">
                                    <li>Version 1.0 completed.</li>
                                </ul>
                            </div>
                            <div className="pt-4 border-t flex justify-end">
                                <button onClick={closeModals} className={`px-4 py-2 rounded-lg text-xs font-bold transition-all active:scale-95 ${themeClasses.btnSecondary}`}>
                                    Close
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Privacy Policy Modal */}
            {modals.privacy && (
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 backdrop-blur-xs">
                    <div className={`rounded-2xl shadow-xl w-full max-w-lg overflow-hidden border animate-in fade-in zoom-in-95 duration-200 ${themeClasses.cardBg}`}>
                        <div className="p-4 border-b flex justify-between items-center bg-gray-50/5">
                            <h3 className={`font-bold text-lg ${themeClasses.textAccent}`}>Privacy Policy</h3>
                            <button onClick={closeModals} className="text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-500/10 transition-colors"><X size={20} /></button>
                        </div>
                        <div className="p-6 space-y-4 max-h-[60vh] overflow-y-auto text-xs leading-relaxed">
                            {/* Overview */}
                            <div>
                                <p className="font-semibold mb-1">Overview</p>
                                <p className={`${themeClasses.textSecondary}`}>
                                    Batch Emailer is a client-side web application for contact management and batch email drafting. This policy explains what data is collected, how it is stored and protected, and your rights regarding that data.
                                </p>
                            </div>

                            {/* Data Collected */}
                            <div>
                                <p className="font-semibold mb-1">Data Collected</p>
                                <div className={`${themeClasses.textSecondary} space-y-0.5`}>
                                    <p>Batch Emailer collects the following personal information that you enter:</p>
                                    <ul className="list-disc pl-4 space-y-0.5 mt-1">
                                        <li><strong>Contact names</strong></li>
                                        <li><strong>Email addresses</strong> (one or more per contact)</li>
                                        <li><strong>Notes</strong> (free-text field for additional details)</li>
                                        <li><strong>Communication history</strong> (timestamps and message content)</li>
                                        <li><strong>Group/folder organization</strong> (names and structure you create)</li>
                                    </ul>
                                </div>
                            </div>

                            {/* How Data Is Stored */}
                            <div>
                                <p className="font-semibold mb-1">How Data Is Stored</p>
                                <p className={`${themeClasses.textSecondary}`}>
                                    All data is stored <strong>exclusively in your browser</strong> using localStorage (active data) and IndexedDB (automatic backups). No data is transmitted to any server, cloud service, or third party.
                                </p>
                            </div>

                            {/* Data Protection */}
                            <div>
                                <p className="font-semibold mb-1">Data Protection</p>
                                <div className={`${themeClasses.textSecondary} space-y-1`}>
                                    <p><strong>Encryption at Rest:</strong> Exported backup files use AES-256-GCM with PBKDF2 key derivation. Automatic IndexedDB backups use the same AES-256-GCM standard when you set an encryption password.</p>
                                    <p><strong>Access Control:</strong> Data is accessible to anyone with physical or browser access to your device. No account system, no login, no remote access.</p>
                                </div>
                            </div>

                            {/* Data Retention */}
                            <div>
                                <p className="font-semibold mb-1">Data Retention</p>
                                <p className={`${themeClasses.textSecondary}`}>
                                    Data is retained until you manually delete it or clear browser storage. No automatic expiration. You can delete all data at any time.
                                </p>
                            </div>

                            {/* Third-Party Services */}
                            <div>
                                <p className="font-semibold mb-1">Third-Party Services</p>
                                <div className={`${themeClasses.textSecondary} space-y-1`}>
                                    <p><strong>Email composition:</strong> Recipient addresses, subjects, and message content are passed to your email provider (Gmail/Outlook) via URL parameters when you choose to compose.</p>
                                    <p><strong>CDN scripts:</strong> PDF libraries are loaded from cdnjs.cloudflare.com at runtime. No personal data from your contacts is sent to the CDN.</p>
                                </div>
                            </div>

                            {/* Your Rights */}
                            <div>
                                <p className="font-semibold mb-1">Your Rights</p>
                                <p className={`${themeClasses.textSecondary}`}>
                                    Under FIPPA and applicable privacy laws, you have the right to access, correct, delete, and export your data at any time.
                                </p>
                            </div>

                            {/* Children's Privacy */}
                            <div>
                                <p className="font-semibold mb-1">Children's Privacy</p>
                                <p className={`${themeClasses.textSecondary}`}>
                                    This application may be used to manage contact information for students or minors. Users are responsible for ensuring they have appropriate authorization.
                                </p>
                            </div>
                        </div>
                        <div className="p-4 border-t flex justify-end bg-gray-50/5">
                            <button onClick={closeModals} className={`px-5 py-2 rounded-lg text-xs font-bold transition-all active:scale-95 ${themeClasses.btnSecondary}`}>
                                Close
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Draft Email Modal */}
            {modals.draftEmail && (
                <DraftEmailModal
                    selectedStudents={data.students.filter(s => selectedStudents.includes(s.id))}
                    closeModal={closeModals}
                    groupName={currentClass?.name || ''}
                    onLogMessage={(message, subject) => {
                        const timestamp = new Date().toISOString();
                        setData(prev => ({
                            ...prev,
                            students: prev.students.map(s => {
                                if (selectedStudents.includes(s.id)) {
                                    const currentHistory = s.emailHistory || [];
                                    const newLog = {
                                        id: generateId(),
                                        timestamp,
                                        message,
                                        subject: subject || ''
                                    };
                                    return {
                                        ...s,
                                        timestamp,
                                        message,
                                        emailHistory: [newLog, ...currentHistory]
                                    };
                                }
                                return s;
                            })
                        }));
                        setSelectedStudents([]);
                        closeModals();
                    }}
                    themeClasses={themeClasses}
                />
            )}

            {/* Sync Conflict Resolution Modal */}
            {showSyncConflictModal && syncConflictData && (
                <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[100] p-4 backdrop-blur-xs">
                    <div className={`rounded-2xl shadow-2xl w-full max-w-md overflow-hidden border animate-in fade-in zoom-in-95 duration-200 ${themeClasses.cardBg}`}>
                        <div className="p-5 border-b flex items-center gap-3 bg-gray-50/5">
                            <AlertTriangle className="flex-shrink-0 text-amber-400" size={22} />
                            <div>
                                <h3 className={`font-extrabold text-base tracking-tight ${themeClasses.textPrimary}`}>Sync Conflict</h3>
                                <p className={`text-xs ${themeClasses.textMuted}`}>Both local data and the sync file have changes.</p>
                            </div>
                        </div>
                        <div className="p-5 space-y-3 max-h-64 overflow-y-auto">
                            {syncConflictData.comparison && (
                                <div className={`p-2.5 rounded-lg text-xs space-y-1 border ${isDark ? 'border-[#4a474a] bg-[#221f22]' : 'border-[#e1d5e3] bg-gray-50'}`}>
                                    <div className="flex justify-between items-center">
                                        <span className="font-semibold text-[#fc9867]">Local:</span>
                                        <span className={`text-[11px] ${themeClasses.textMuted}`}>{syncConflictData.comparison.localDevice || getDeviceName()}</span>
                                    </div>
                                    <div className="flex justify-between items-center">
                                        <span className="font-semibold text-[#78dce8]">Sync File:</span>
                                        <span className={`text-[11px] ${themeClasses.textMuted}`}>{syncConflictData.comparison.fileDevice || syncConflictData.fileName}</span>
                                    </div>
                                </div>
                            )}
                            {syncConflictData.comparison && syncConflictData.comparison.hasDifferences ? (
                                <div className="space-y-2">
                                    {syncConflictData.comparison.differences.map((diff, i) => (
                                        <div key={i} className={`px-3 py-2 rounded-lg text-xs border ${isDark ? 'border-[#4a474a] bg-[#221f22]' : 'border-[#e1d5e3] bg-[#f5ecf7]'}`}>
                                            <p className="font-semibold">{diff.description}</p>
                                            {Array.isArray(diff.items) && diff.items.length > 0 && diff.items[0]?.changes && (
                                                <ul className={`mt-1 text-[10px] ${themeClasses.textMuted} list-disc list-inside`}>
                                                    {diff.items.slice(0, 4).map((item, j) => (
                                                        <li key={j}>{item.name}: {(item.changes || []).join('; ')}</li>
                                                    ))}
                                                </ul>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <p className={`text-sm ${themeClasses.textSecondary}`}>Both sides have unseen changes. Choose which version to keep.</p>
                            )}
                        </div>
                        <div className="p-4 bg-gray-50/5 border-t space-y-2">
                            <p className={`text-[11px] font-bold ${themeClasses.textMuted} mb-2`}>Which version do you want to keep?</p>
                            <div className="flex gap-2">
                                <button
                                    type="button"
                                    onClick={handleResolveConflictKeepFile}
                                    className={`flex-1 py-2.5 rounded-lg text-xs font-bold transition-all active:scale-95 ${isDark ? 'bg-[#78dce8]/10 text-[#78dce8] border border-[#78dce8]/30 hover:bg-[#78dce8]/20' : 'bg-[#e8f4f7] text-[#13677a] border border-[#2188a0]/30 hover:bg-[#d0ecf2]'}`}
                                >
                                    Keep File Version
                                </button>
                                <button
                                    type="button"
                                    onClick={handleResolveConflictKeepLocal}
                                    className={`flex-1 py-2.5 rounded-lg text-xs font-bold transition-all active:scale-95 ${themeClasses.btnPrimary}`}
                                >
                                    Keep My Local Data
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Restore Choice Modal */}
            {showRestoreChoiceModal && pendingRestoreData && (
                <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[100] p-4 backdrop-blur-xs">
                    <div className={`rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden border animate-in fade-in zoom-in-95 duration-200 ${themeClasses.cardBg}`}>
                        <div className="p-5 border-b flex items-center gap-3 bg-gray-50/5">
                            <Upload className="flex-shrink-0 text-emerald-400" size={22} />
                            <div>
                                <h3 className={`font-extrabold text-base tracking-tight ${themeClasses.textPrimary}`}>Restore from Backup</h3>
                                <p className={`text-xs ${themeClasses.textMuted} truncate max-w-[220px]`}>{pendingRestoreData.fileName}</p>
                            </div>
                        </div>
                        <div className={`p-5 text-sm leading-relaxed ${themeClasses.textSecondary}`}>
                            <div className="space-y-3">
                                <p>How would you like to restore this backup?</p>
                                <div className={`px-3 py-2 rounded-lg text-xs space-y-1 ${isDark ? 'bg-[#221f22]' : 'bg-[#f5f0ec]'}`}>
                                    <p><strong>{pendingRestoreData.normalized.folders.length}</strong> folders</p>
                                    <p><strong>{pendingRestoreData.normalized.classes.length}</strong> groups</p>
                                    <p><strong>{pendingRestoreData.normalized.students.length}</strong> contacts</p>
                                    <p className={isDark ? 'text-[#a9dc76]' : 'text-[#3f7a1a]'}><strong>{countEmailMessages(pendingRestoreData.normalized)}</strong> email messages</p>
                                </div>
                            </div>
                        </div>
                        <div className="p-4 bg-gray-50/5 border-t space-y-2">
                            <button
                                type="button"
                                onClick={handleRestoreReplaceAll}
                                className={`w-full py-2.5 rounded-lg text-xs font-bold transition-all active:scale-95 ${isDark ? 'bg-rose-500/10 text-rose-400 border border-rose-500/30 hover:bg-rose-500/20' : 'bg-rose-50 text-rose-700 border border-rose-200 hover:bg-rose-100'}`}
                            >
                                Replace All Data
                                <span className={`block text-[10px] font-normal mt-0.5 ${isDark ? 'text-rose-400/70' : 'text-rose-500/70'}`}>Overwrites everything with the backup</span>
                            </button>
                            <button
                                type="button"
                                onClick={handleRestoreImportNew}
                                className={`w-full py-2.5 rounded-lg text-xs font-bold transition-all active:scale-95 ${themeClasses.btnSecondary}`}
                            >
                                Import New Items Only
                                <span className={`block text-[10px] font-normal mt-0.5 ${themeClasses.textMuted}`}>Adds new items and merges new email messages into contacts you already have</span>
                            </button>
                            <button
                                type="button"
                                onClick={() => { setShowRestoreChoiceModal(false); setPendingRestoreData(null); }}
                                className={`w-full py-1.5 rounded-lg text-xs font-bold transition-all ${themeClasses.textMuted} hover:underline`}
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                </div>
            )}


            {/* --- CONTACT ROW CONTEXT MENU (Right-click) --- */}
            {contextMenu && (
                <div
                    className={`fixed z-[110] min-w-[196px] rounded-xl border shadow-2xl py-1.5 overflow-hidden animate-in fade-in zoom-in-95 duration-100 ${themeClasses.cardBg}`}
                    style={{ left: contextMenu.x, top: contextMenu.y }}
                    onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
                    onClick={(e) => e.stopPropagation()}
                >
                    <div className={`px-3 pt-1.5 pb-2 border-b ${themeClasses.border}`}>
                        <p className={`text-xs font-extrabold truncate ${themeClasses.textPrimary}`}>{contextTargetStudent?.name || 'Contact'}</p>
                        <p className={`text-[10px] font-semibold ${themeClasses.textMuted}`}>
                            {selectedStudents.length > 1 ? `${selectedStudents.length} contacts selected` : '1 contact selected'}
                        </p>
                    </div>
                    <button
                        type="button"
                        disabled={!contextTargetStudent}
                        onClick={() => {
                            setContextMenu(null);
                            if (contextTargetStudent) openEditModal('student', contextTargetStudent);
                        }}
                        className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm font-semibold text-left transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${isDark ? 'hover:bg-[#4a474a] text-[#fcfaf2]' : 'hover:bg-[#f2ece0] text-[#2d2a2e]'}`}
                    >
                        <Edit2 size={14} className="shrink-0" /> Edit Contact
                    </button>
                    <div className={`my-1 border-t ${themeClasses.border}`} />
                    <button
                        type="button"
                        onClick={() => {
                            const targets = contextMenuTargets;
                            setContextMenu(null);
                            deleteStudents(targets);
                        }}
                        className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm font-bold text-left transition-colors ${isDark ? 'hover:bg-[#ff6188]/20 text-[#ff6188]' : 'hover:bg-[#e0466a]/10 text-[#e0466a]'}`}
                    >
                        <Trash2 size={14} className="shrink-0" /> {contextMenuDeleteLabel}
                    </button>
                </div>
            )}

            {/* --- CUSTOM DIALOG OVERLAY (Replaces window.confirm & window.alert) --- */}
            {customDialog.isOpen && (
                <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[100] p-4 backdrop-blur-xs">
                    <div className={`rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden border animate-in fade-in zoom-in-95 duration-200 ${themeClasses.cardBg}`}>
                        <div className="p-5 border-b flex items-center gap-3 bg-gray-50/5">
                            <AlertCircle className={`flex-shrink-0 ${customDialog.isConfirm ? 'text-blue-400' : 'text-yellow-400 animate-bounce'}`} size={24} />
                            <h3 className={`font-extrabold text-lg tracking-tight ${themeClasses.textPrimary}`}>{customDialog.title}</h3>
                        </div>
                        <div className={`p-5 text-sm leading-relaxed font-medium transition-colors duration-300 ${themeClasses.textSecondary}`}>
                            {customDialog.message}
                        </div>
                        <div className="p-4 bg-gray-50/5 border-t flex justify-end gap-2">
                            {customDialog.isConfirm ? (
                                <>
                                    <button
                                        type="button"
                                        onClick={() => setCustomDialog(prev => ({ ...prev, isOpen: false }))}
                                        className={`px-4 py-2 rounded-lg text-xs font-bold transition-all active:scale-95 ${themeClasses.btnSecondary}`}
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        type="button"
                                        onClick={customDialog.onConfirm}
                                        className="px-4 py-2 text-white bg-red-500 hover:bg-red-600 rounded-lg text-xs font-bold shadow-sm transition-all active:scale-95"
                                    >
                                        Confirm
                                    </button>
                                </>
                            ) : (
                                <button
                                    type="button"
                                    onClick={() => setCustomDialog(prev => ({ ...prev, isOpen: false }))}
                                    className={`px-5 py-2 rounded-lg text-xs font-bold transition-all active:scale-95 ${themeClasses.btnPrimary}`}
                                >
                                    OK
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* Hidden file input for mobile/non-FSA sync pull */}
            <input
                type="file"
                id="mobile-sync-pull-input"
                accept=".json"
                className="hidden"
                onChange={handleMobileSyncPull}
            />

            {/* Floating Sync Toast */}
            {syncToast && (
                <div
                    key={syncToast.id}
                    className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-[200] px-5 py-3 rounded-xl shadow-2xl border text-sm font-semibold flex items-center gap-2.5 max-w-md animate-in fade-in slide-in-from-bottom-4 duration-300 ${
                        syncToast.type === 'success'
                            ? isDark
                                ? 'bg-[#221f22] border-[#a9dc76]/40 text-[#a9dc76] shadow-[#a9dc76]/10'
                                : 'bg-white border-emerald-300 text-emerald-700 shadow-emerald-100'
                            : syncToast.type === 'error'
                            ? isDark
                                ? 'bg-[#221f22] border-[#ff6188]/40 text-[#ff6188] shadow-[#ff6188]/10'
                                : 'bg-white border-rose-300 text-rose-700 shadow-rose-100'
                            : syncToast.type === 'warn'
                            ? isDark
                                ? 'bg-[#221f22] border-[#fc9867]/40 text-[#fc9867] shadow-[#fc9867]/10'
                                : 'bg-white border-amber-300 text-amber-700 shadow-amber-100'
                            : isDark
                            ? 'bg-[#221f22] border-[#78dce8]/40 text-[#78dce8] shadow-[#78dce8]/10'
                            : 'bg-white border-sky-300 text-sky-700 shadow-sky-100'
                    }`}
                >
                    {syncToast.type === 'success' && <CheckCircle2 size={16} className="shrink-0" />}
                    {syncToast.type === 'error' && <AlertTriangle size={16} className="shrink-0" />}
                    {syncToast.type === 'warn' && <AlertTriangle size={16} className="shrink-0" />}
                    {syncToast.type === 'info' && <RefreshCw size={16} className="shrink-0" />}
                    <span className="truncate">{syncToast.message}</span>
                    <button
                        onClick={() => setSyncToast(null)}
                        className="p-0.5 rounded hover:bg-black/10 transition-colors shrink-0"
                    >
                        <X size={14} />
                    </button>
                </div>
            )}

        </div>
    );
}

// --- Import Contacts Sub-Component ---

// Sample rows shown inside the import dialog. Every value here is invented
// (RFC 2606 reserves example.com / example.org / example.net, and 555-01xx
// phone numbers), so no real contact data is ever shown or shipped.
const IMPORT_EXAMPLE_PASTE = [
    'Name\tEmail\tEmail 2\tNotes',
    'Jamie Rivera\tjamie.rivera@example.com\tparent@example.org\tSibling: Alex Rivera',
    'Priya Nair, priya.nair@example.com, Class rep',
    'Sam Lee',
    'sam.lee@example.com',
    'parent@example.com'
].join('\n');

const IMPORT_EXAMPLE_CSV = [
    'Name,Email,Email 2,Notes',
    'Jamie Rivera,jamie.rivera@example.com,parent@example.org,Sibling: Alex Rivera',
    'Priya Nair,priya.nair@example.com,,Class rep',
    'Sam Lee,sam.lee@example.com,parent@example.com,New neighbour'
].join('\n');

function ImportContactsModal({ onImportContacts, existingStudents = [], closeModal, themeClasses }) {
    const [activeTab, setActiveTab] = useState('paste'); // 'paste' | 'csv'
    const [previewRows, setPreviewRows] = useState([]); // { key, name, emails, notes }
    const [previewSource, setPreviewSource] = useState('');
    const [parseError, setParseError] = useState('');
    const [skipExisting, setSkipExisting] = useState(true);
    const [csvFileName, setCsvFileName] = useState('');
    const [pasteText, setPasteText] = useState('');
    const fileInputRef = useRef(null);
    const isDark = themeClasses.textPrimary.includes('text-[#fcfaf2]');

    // Lookup of what is already stored, so the preview can flag duplicates.
    const existingIndex = { names: new Set(), emails: new Set() };
    (existingStudents || []).forEach(s => {
        const name = String(s?.name || '').trim().toLowerCase();
        if (name) existingIndex.names.add(name);
        (s?.emails || []).forEach(addr => {
            const value = String(addr || '').trim().toLowerCase();
            if (value) existingIndex.emails.add(value);
        });
    });

    const rowEmailList = (row) => String(row?.emails || '')
        .split(/[\s,;]+/)
        .map(e => e.trim())
        .filter(Boolean);

    const matchesExisting = (name, emails) => {
        const cleanName = String(name || '').trim().toLowerCase();
        if (cleanName && existingIndex.names.has(cleanName)) return true;
        return emails.some(addr => existingIndex.emails.has(String(addr).toLowerCase()));
    };

    // Work out exactly which rows would be imported, before importing.
    const computeImportPlan = () => {
        const seen = new Set();
        const rows = [];
        let skippedExisting = 0;
        let duplicates = 0;
        let needsName = 0;

        previewRows.forEach(row => {
            const name = String(row.name || '').trim();
            const emails = rowEmailList(row);
            if (!name) {
                needsName += 1;
                return;
            }
            const key = `${name.toLowerCase()}|${emails.map(e => e.toLowerCase()).sort().join(',')}`;
            if (seen.has(key)) {
                duplicates += 1;
                return;
            }
            if (skipExisting && matchesExisting(name, emails)) {
                skippedExisting += 1;
                return;
            }
            seen.add(key);
            rows.push({ name, emails, notes: String(row.notes || '').trim() });
        });

        return { rows, skippedExisting, duplicates, needsName, total: previewRows.length };
    };

    const importPlan = computeImportPlan();

    const showPreview = (records, source) => {
        if (!records || records.length === 0) {
            setPreviewRows([]);
            setPreviewSource('');
            setParseError('No contacts found in that data — each contact needs a name and/or an email address.');
            return;
        }
        setPreviewRows(records.map((record, index) => ({
            key: `${Date.now()}-${index}`,
            name: record.name || '',
            emails: (record.emails || []).join(', '),
            notes: record.notes || ''
        })));
        setPreviewSource(source);
        setParseError('');
    };

    const handlePasteSubmit = (e) => {
        e.preventDefault();
        const text = e.target.bulkData.value;
        setPasteText(text);
        showPreview(parseContactsFromText(text), 'pasted text');
    };

    const updateRow = (key, field, value) => {
        setParseError('');
        setPreviewRows(rows => rows.map(row => row.key === key ? { ...row, [field]: value } : row));
    };

    const removeRow = (key) => {
        setParseError('');
        setPreviewRows(rows => rows.filter(row => row.key !== key));
    };

    const addRow = () => {
        setParseError('');
        setPreviewRows(rows => [...rows, {
            key: `${Date.now()}-${rows.length}-new`,
            name: '', emails: '', notes: ''
        }]);
    };

    const clearPreview = () => {
        setPreviewRows([]);
        setPreviewSource('');
        setParseError('');
    };

    const handleImport = () => {
        const plan = computeImportPlan();
        if (plan.rows.length === 0) {
            setParseError(plan.total === 0
                ? 'There is nothing to import yet.'
                : skipExisting && plan.skippedExisting > 0
                    ? 'Everything here already exists in your contacts. Uncheck "Skip contacts I already have" to import anyway.'
                    : 'Add a contact name to at least one row before importing.');
            return;
        }
        onImportContacts(plan.rows, plan.skippedExisting + plan.duplicates);
    };

    const handleFileChange = (e) => {
        const file = e.target.files[0];
        if (!file) return;

        setCsvFileName(file.name);
        const reader = new FileReader();
        reader.onload = (event) => {
            const text = event.target.result;
            const csvRows = parseCSV(text);
            const multiColumn = csvRows.some(row => row.length > 1);
            // Files saved out of Sheets/Docs are often really tab separated,
            // and single-column files are just "name line / email line" lists.
            const records = multiColumn ? buildContactRecords(csvRows) : parseContactsFromText(text);
            showPreview(records, file.name);
        };
        reader.readAsText(file);
    };

    // Hands the user a working sample file so the upload path can be tried
    // end to end. Contents are the same invented rows as the paste example.
    const downloadCsvExample = () => {
        const blob = new Blob([`${IMPORT_EXAMPLE_CSV}\n`], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'sample-contacts.csv';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    };

    return (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4 backdrop-blur-xs">
            <div className={`rounded-2xl shadow-xl w-full max-w-2xl overflow-hidden flex flex-col h-[80vh] border animate-in fade-in zoom-in-95 duration-200 ${themeClasses.cardBg}`}>
                <div className="p-4 border-b flex justify-between items-center bg-gray-50/5">
                    <h3 className={`font-bold text-lg ${isDark ? 'text-[#78dce8]' : 'text-[#00838f]'}`}>Import Contacts</h3>
                    <button onClick={closeModal} className="text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-500/10 transition-colors"><X size={20} /></button>
                </div>

                {/* Tab Controls */}
                {previewRows.length === 0 && (
                    <div className="flex border-b border-gray-200/10">
                        <button
                            type="button"
                            onClick={() => setActiveTab('paste')}
                            className={`flex-1 py-3 text-center text-sm font-bold border-b-2 transition-all ${activeTab === 'paste' ? 'border-[#ff6188] text-[#ff6188] bg-[#ff6188]/5' : 'border-transparent text-gray-400 hover:text-gray-200'}`}
                        >
                            Paste Rows
                        </button>
                        <button
                            type="button"
                            onClick={() => setActiveTab('csv')}
                            className={`flex-1 py-3 text-center text-sm font-bold border-b-2 transition-all ${activeTab === 'csv' ? 'border-b-[#ff6188] text-[#ff6188] bg-[#ff6188]/5' : 'border-transparent text-gray-400 hover:text-gray-200'}`}
                        >
                            Upload CSV File
                        </button>
                    </div>
                )}

                <div className="flex-1 flex flex-col p-5 overflow-hidden min-h-0">
                    {parseError && (
                        <div className="bg-[#ff6188]/10 border border-[#ff6188]/20 text-[#ff6188] p-3 rounded-xl text-xs mb-4 leading-relaxed font-semibold">
                            {parseError}
                        </div>
                    )}

                    {previewRows.length > 0 ? (
                        /* ---------- Step 2: review & adjust before importing ---------- */
                        <div className="flex-1 flex flex-col min-h-0 animate-in fade-in duration-200">
                            <div className="flex items-start justify-between gap-3 mb-3">
                                <div className="min-w-0">
                                    <h4 className="font-extrabold text-xs text-gray-400 uppercase tracking-wider">Review before importing</h4>
                                    <p className="text-[11px] text-gray-500 mt-0.5">
                                        {previewRows.length} row{previewRows.length === 1 ? '' : 's'} read from {previewSource}. Edit anything that looks wrong, delete rows you don't want, then import.
                                    </p>
                                </div>
                                <div className="flex gap-2 flex-shrink-0">
                                    <button type="button" onClick={clearPreview} className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${themeClasses.btnSecondary}`}>Back</button>
                                    <button type="button" onClick={addRow} className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1 ${themeClasses.btnSecondary}`}>
                                        <Plus size={12} /> Add Row
                                    </button>
                                </div>
                            </div>

                            <div className="hidden sm:flex gap-2 px-1 pb-1 text-[10px] font-bold uppercase tracking-wider text-gray-400">
                                <span className="flex-1">Name</span>
                                <span className="flex-[1.4]">Emails (comma separated)</span>
                                <span className="flex-1">Notes</span>
                                <span className="w-6" />
                            </div>

                            <div className="flex-1 min-h-0 overflow-y-auto border border-gray-200/10 rounded-xl bg-gray-500/5 p-2 space-y-2">
                                {previewRows.map(row => {
                                    const missingName = String(row.name).trim() === '';
                                    const duplicate = !missingName && matchesExisting(row.name, rowEmailList(row));
                                    return (
                                        <div key={row.key} className="pr-1">
                                            <div className="flex items-center gap-2">
                                                <input
                                                    value={row.name}
                                                    onChange={e => updateRow(row.key, 'name', e.target.value)}
                                                    placeholder="Full name"
                                                    className={`min-w-0 flex-1 border rounded-lg px-2.5 py-2 text-xs outline-none focus:ring-2 focus:ring-[#ff6188] transition-all ${missingName ? 'border-[#ff6188]/70' : 'border-gray-200/15'}`}
                                                />
                                                <input
                                                    value={row.emails}
                                                    onChange={e => updateRow(row.key, 'emails', e.target.value)}
                                                    placeholder="a@example.com, b@example.com"
                                                    className="min-w-0 flex-[1.4] border border-gray-200/15 rounded-lg px-2.5 py-2 text-xs outline-none focus:ring-2 focus:ring-[#ff6188] transition-all"
                                                />
                                                <input
                                                    value={row.notes}
                                                    onChange={e => updateRow(row.key, 'notes', e.target.value)}
                                                    placeholder="Optional note"
                                                    className="min-w-0 flex-1 border border-gray-200/15 rounded-lg px-2.5 py-2 text-xs outline-none focus:ring-2 focus:ring-[#ff6188] transition-all"
                                                />
                                                <button
                                                    type="button"
                                                    onClick={() => removeRow(row.key)}
                                                    title="Remove this row"
                                                    className="text-gray-500 hover:text-[#ff6188] p-1.5 rounded-lg hover:bg-[#ff6188]/10 transition-all flex-shrink-0"
                                                >
                                                    <Trash size={13} />
                                                </button>
                                            </div>
                                            {(missingName || duplicate) && (
                                                <p className={`text-[10px] font-bold mt-1 ml-1 ${missingName ? 'text-[#ff6188]' : isDark ? 'text-[#ffd866]' : 'text-[#8a6d00]'}`}>
                                                    {missingName ? 'Needs a name to be imported' : 'Matches a contact you already have'}
                                                </p>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>

                            <div className="flex flex-wrap items-end justify-between gap-3 pt-3 mt-3 border-t border-gray-200/10">
                                <div className="space-y-1.5 text-[11px] font-semibold text-gray-400">
                                    <p>
                                        <span className="text-[#a9dc76] font-bold">{importPlan.rows.length}</span> ready to import
                                        {importPlan.skippedExisting > 0 && ` · ${importPlan.skippedExisting} already in your contacts`}
                                        {importPlan.duplicates > 0 && ` · ${importPlan.duplicates} duplicate row${importPlan.duplicates === 1 ? '' : 's'}`}
                                        {importPlan.needsName > 0 && ` · ${importPlan.needsName} without a name`}
                                    </p>
                                    <label className="flex items-center gap-1.5 cursor-pointer select-none">
                                        <input
                                            type="checkbox"
                                            checked={skipExisting}
                                            onChange={e => setSkipExisting(e.target.checked)}
                                            className="accent-[#ff6188]"
                                        />
                                        Skip contacts I already have
                                    </label>
                                </div>
                                <div className="flex gap-2">
                                    <button type="button" onClick={closeModal} className={`px-4 py-2 rounded-lg text-xs font-bold transition-all ${themeClasses.btnSecondary}`}>Cancel</button>
                                    <button
                                        type="button"
                                        onClick={handleImport}
                                        disabled={importPlan.rows.length === 0}
                                        className={`px-5 py-2 rounded-lg text-xs font-bold transition-all active:scale-95 ${importPlan.rows.length > 0 ? themeClasses.btnPrimary : 'bg-gray-200 text-gray-400 cursor-not-allowed shadow-none'}`}
                                    >
                                        Import {importPlan.rows.length} Contact{importPlan.rows.length === 1 ? '' : 's'}
                                    </button>
                                </div>
                            </div>
                        </div>
                    ) : activeTab === 'paste' ? (
                        /* ---------- Step 1: paste anything ---------- */
                        <form onSubmit={handlePasteSubmit} className="flex-1 flex flex-col min-h-0 overflow-y-auto">
                            <div className="bg-[#ff6188]/10 border border-[#ff6188]/20 text-[#ff6188] p-3 rounded-xl text-xs mb-4 leading-relaxed font-semibold">
                                <strong>Paste anything:</strong> spreadsheet rows, a table copied out of Google Docs (tab separated), comma separated values, or a simple list where each <strong>name sits above/beside its emails</strong>.
                                Header rows are skipped, several emails per contact are kept, and you'll review and adjust everything before it is imported.
                            </div>

                            <div className="border border-gray-200/10 rounded-xl bg-gray-500/5 p-3 mb-4">
                                <div className="flex items-center justify-between gap-2 mb-2">
                                    <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Example (all fake data)</span>
                                    <button
                                        type="button"
                                        onClick={() => setPasteText(IMPORT_EXAMPLE_PASTE)}
                                        className="px-2.5 py-1 rounded-lg text-[11px] font-bold bg-[#ff6188]/15 text-[#ff6188] hover:bg-[#ff6188]/25 transition-all flex-shrink-0"
                                    >
                                        Use this example
                                    </button>
                                </div>
                                <pre className="font-mono text-[11px] leading-5 whitespace-pre overflow-x-auto text-gray-300" style={{ tabSize: 4 }}>{IMPORT_EXAMPLE_PASTE}</pre>
                                <ul className="mt-2 space-y-1 text-[11px] text-gray-500 leading-relaxed">
                                    <li><span className="font-bold text-gray-400">Line 1</span> — header row, it is skipped.</li>
                                    <li><span className="font-bold text-gray-400">Line 2</span> — one spreadsheet row: name, two emails, a note (columns are split on tabs).</li>
                                    <li><span className="font-bold text-gray-400">Line 3</span> — the same thing, comma separated: name, email, note.</li>
                                    <li><span className="font-bold text-gray-400">Lines 4–6</span> — a name with its emails underneath: both addresses belong to Sam Lee.</li>
                                </ul>
                            </div>

                            <textarea
                                required
                                autoFocus
                                name="bulkData"
                                value={pasteText}
                                onChange={e => setPasteText(e.target.value)}
                                placeholder={'Paste your rows here, or click "Use this example" above to load the sample.'}
                                className="w-full flex-1 min-h-[120px] border border-gray-200/10 rounded-xl p-3.5 font-mono text-sm focus:ring-2 focus:ring-[#ff6188] outline-none whitespace-pre overflow-auto bg-gray-500/5 text-[#fcfaf2] dark:text-[#fcfaf2]"
                            />
                            <div className="flex justify-end gap-2 pt-4 mt-4 border-t border-gray-200/10">
                                <button type="button" onClick={closeModal} className={`px-4 py-2 rounded-lg text-xs font-bold transition-all ${themeClasses.btnSecondary}`}>Cancel</button>
                                <button type="submit" className={`px-5 py-2 rounded-lg text-xs font-bold transition-all active:scale-95 ${themeClasses.btnPrimary}`}>Preview Import</button>
                            </div>
                        </form>
                    ) : (
                        /* ---------- Step 1: upload a file ---------- */
                        <div className="flex-1 flex flex-col min-h-0 overflow-y-auto">
                            <div className="bg-[#78dce8]/10 border border-[#78dce8]/20 text-[#78dce8] p-3 rounded-xl text-xs mb-4 leading-relaxed font-semibold">
                                <strong>Upload CSV:</strong> comma or tab separated, with or without a header row. The first text cell is read as the name, anything with an <code>@</code> becomes an email, and other cells become notes. You'll review everything before it is imported.
                            </div>

                            <div className="border border-gray-200/10 rounded-xl bg-gray-500/5 p-3 mb-4">
                                <div className="flex items-center justify-between gap-2 mb-2">
                                    <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Example (all fake data)</span>
                                    <button
                                        type="button"
                                        onClick={downloadCsvExample}
                                        className="px-2.5 py-1 rounded-lg text-[11px] font-bold bg-[#78dce8]/15 text-[#78dce8] hover:bg-[#78dce8]/25 transition-all flex flex-shrink-0 items-center gap-1"
                                    >
                                        <Download size={12} /> Sample file
                                    </button>
                                </div>
                                <pre className="font-mono text-[11px] leading-5 whitespace-pre overflow-x-auto text-gray-300">{IMPORT_EXAMPLE_CSV}</pre>
                                <ul className="mt-2 space-y-1 text-[11px] text-gray-500 leading-relaxed">
                                    <li><span className="font-bold text-gray-400">Row 1</span> — header row; it is skipped, but it can also be left out.</li>
                                    <li><span className="font-bold text-gray-400">Row 2</span> — name, two emails (one per column), note.</li>
                                    <li><span className="font-bold text-gray-400">Rows 3–4</span> — one email each; an empty <code>Email 2</code> cell is fine.</li>
                                </ul>
                            </div>

                            <div className="flex flex-col items-center justify-center p-8 border-2 border-dashed border-gray-300/30 rounded-2xl hover:bg-gray-500/5 transition-all mb-4 cursor-pointer" onClick={() => fileInputRef.current.click()}>
                                <FileSpreadsheet size={40} className="text-gray-400 mb-2 animate-bounce" />
                                <span className="text-sm font-bold text-gray-300 text-center">
                                    {csvFileName ? `Selected: ${csvFileName}` : 'Click to upload or select a CSV file'}
                                </span>
                                <input
                                    type="file"
                                    ref={fileInputRef}
                                    accept=".csv,.tsv,.txt"
                                    className="hidden"
                                    onChange={handleFileChange}
                                />
                            </div>

                            <div className="flex justify-end gap-2 pt-4 mt-auto border-t border-gray-200/10">
                                <button type="button" onClick={closeModal} className={`px-4 py-2 rounded-lg text-xs font-bold transition-all ${themeClasses.btnSecondary}`}>Cancel</button>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

// --- Draft Email Sub-Component ---
function DraftEmailModal({ selectedStudents, closeModal, groupName, onLogMessage, themeClasses }) {
    const [message, setMessage] = useState('');
    const defaultSubject = groupName ? `${groupName} Update` : 'Student Update Notification';
    const [subject, setSubject] = useState(defaultSubject);
    const [draftGenerated, setDraftGenerated] = useState(false);
    const [batches, setBatches] = useState([]);
    const [copiedBccIdx, setCopiedBccIdx] = useState(null);
    const [copiedBodyIdx, setCopiedBodyIdx] = useState(null);
    const [outlookClickedIdx, setOutlookClickedIdx] = useState(null);
    const isDark = themeClasses.textPrimary.includes('text-[#fcfaf2]');

    // Track active timers for cleanup to prevent memory leaks
    const timersRef = useRef([]);
    useEffect(() => {
        return () => {
            timersRef.current.forEach(clearTimeout);
        };
    }, []);
    const safeTimeout = (fn, ms) => {
        const id = setTimeout(fn, ms);
        timersRef.current.push(id);
        return id;
    };

    // Filter contacts who have at least one valid email
    const validStudents = selectedStudents.filter(s => s.emails && s.emails.filter(Boolean).length > 0);
    const missingStudents = selectedStudents.filter(s => !s.emails || s.emails.filter(Boolean).length === 0);

    const generateDrafts = () => {
        if (!message.trim()) return alert("Please type a message first.");

        // Extract raw emails from array, remove duplicates and empty/falsy values
        let rawBccEmails = [];
        validStudents.forEach(s => {
            (s.emails || []).forEach(email => {
                if (email && email.trim()) {
                    rawBccEmails.push(email.trim());
                }
            });
        });

        const bccEmails = Array.from(new Set(rawBccEmails.filter(Boolean)));
        const maxEmails = 50;
        const batchCount = Math.ceil(bccEmails.length / maxEmails);
        const newBatches = [];

        const studentNamesStr = validStudents.map(s => s.name).join('\n');

        for (let j = 0; j < batchCount; j++) {
            const emailChunk = bccEmails.slice(j * maxEmails, (j + 1) * maxEmails);
            const bccString = emailChunk.join(',');

            let messageCountText = "";
            if (batchCount > 1) {
                messageCountText = `\n(Email limits require batches: This is draft ${j + 1} of ${batchCount})`;
            }

            const fullMessage = `------------DELETE BEFORE SENDING------------${messageCountText}\n\nMESSAGE BEING SENT FOR:\n${studentNamesStr}\n\n------------DELETE BEFORE SENDING------------\n\n\n${message}`;

            newBatches.push({ bcc: bccString, body: fullMessage, subject: subject.trim() || defaultSubject });
        }

        setBatches(newBatches);
        setDraftGenerated(true);
    };

    // Clipboard helper
    const handleCopyText = (text, type, index, silent = false) => {
        try {
            const textArea = document.createElement("textarea");
            textArea.value = text;
            textArea.style.position = "fixed";
            textArea.style.top = "0";
            textArea.style.left = "0";
            textArea.style.width = "2em";
            textArea.style.height = "2em";
            textArea.style.padding = "0";
            textArea.style.border = "none";
            textArea.style.outline = "none";
            textArea.style.boxShadow = "none";
            textArea.style.background = "transparent";

            document.body.appendChild(textArea);
            textArea.focus();
            textArea.select();

            const successful = document.execCommand('copy');
            document.body.removeChild(textArea);

            if (successful && !silent) {
                if (type === 'bcc') {
                    setCopiedBccIdx(index);
                    safeTimeout(() => setCopiedBccIdx(null), 2000);
                } else {
                    setCopiedBodyIdx(index);
                    safeTimeout(() => setCopiedBodyIdx(null), 2000);
                }
            }
        } catch (err) {
            console.error('Could not copy text: ', err);
        }
    };

    const handleOutlookClick = (url, bccText, index) => {
        // 1. Instantly copy BCC emails to clipboard silently
        handleCopyText(bccText, 'bcc', index, true);

        // 2. Trigger UI instruction alert state
        setOutlookClickedIdx(index);
        safeTimeout(() => setOutlookClickedIdx(null), 7000);

        // 3. Open Outlook compose link
        window.open(url, '_blank');
    };

    const openLink = (url) => {
        window.open(url, '_blank');
    };

    const handleComplete = () => {
        onLogMessage(message, subject.trim() || defaultSubject);
    };

    return (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4 backdrop-blur-xs">
            <div className={`rounded-2xl shadow-2xl w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh] border animate-in fade-in zoom-in-95 duration-200 ${themeClasses.cardBg}`}>
                <div className="p-5 border-b flex justify-between items-center bg-gray-50/5">
                    <div>
                        <h3 className={`font-bold text-xl ${isDark ? 'text-[#ff6188]' : 'text-[#e0466a]'}`}>Draft Mass Email</h3>
                        <p className="text-sm text-gray-400 font-semibold font-sans">Recipients: {validStudents.length} contacts</p>
                    </div>
                    <button onClick={closeModal} className="text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-500/10 transition-colors bg-white/5 border"><X size={20} /></button>
                </div>

                <div className="p-6 flex-1 overflow-y-auto space-y-5">
                    {missingStudents.length > 0 && !draftGenerated && (
                        <div className="bg-red-500/10 border-l-4 border-red-500 p-4 text-[#ff6188] text-xs font-semibold">
                            <strong>Warning:</strong> {missingStudents.length} selected contact(s) have no email addresses listed. They will be skipped.
                        </div>
                    )}

                    {!draftGenerated ? (
                        <div className="space-y-4 flex flex-col h-full">
                            <p className="text-sm text-[#c1c0c1] font-semibold">
                                Type the subject line and message you would like to send. This exact message will be saved to your local log. You will have a chance to edit the final email in your email app before sending.
                            </p>
                            <div className="flex flex-col gap-1.5">
                                <label className="text-xs font-bold text-gray-400 uppercase tracking-wider">Subject Line</label>
                                <input
                                    type="text"
                                    value={subject}
                                    onChange={(e) => setSubject(e.target.value)}
                                    className={`w-full border border-gray-200/10 rounded-xl p-3 focus:ring-2 focus:ring-[#ff6188] outline-none bg-gray-500/5 font-semibold text-sm ${themeClasses.inputBg || ''}`}
                                    placeholder="Enter email subject line..."
                                />
                            </div>
                            <div className="flex-1 flex flex-col gap-1.5 min-h-[220px]">
                                <label className="text-xs font-bold text-gray-400 uppercase tracking-wider">Message Content</label>
                                <textarea
                                    value={message}
                                    onChange={(e) => setMessage(e.target.value)}
                                    autoFocus
                                    className="w-full flex-1 border border-gray-200/10 rounded-2xl p-4 focus:ring-2 focus:ring-[#ff6188] outline-none resize-none bg-gray-500/5 font-semibold text-sm leading-relaxed"
                                    placeholder="Hello Parents,&#10;&#10;I wanted to share a quick update regarding your child's progress in class this week..."
                                />
                            </div>
                        </div>
                    ) : (
                        <div className="space-y-6">
                            <div className="bg-[#ff6188]/10 border border-[#ff6188]/20 rounded-2xl p-5 text-center">
                                <Check size={40} className="mx-auto text-[#a9dc76] mb-3 animate-bounce" />
                                <h4 className="font-extrabold text-lg mb-1">Drafts Ready!</h4>
                                <p className="text-sm text-[#c1c0c1] mb-4 font-medium">
                                    {batches.length > 1
                                        ? `Due to address limits, your list has been split into ${batches.length} batches.`
                                        : "Your draft is ready. Choose your email service below."}
                                </p>

                                <div className="space-y-4">
                                    {batches.map((batch, idx) => {
                                        const gmailUrl = `https://mail.google.com/mail/?view=cm&fs=1&bcc=${encodeURIComponent(batch.bcc)}&su=${encodeURIComponent(batch.subject)}&body=${encodeURIComponent(batch.body)}`;
                                        const outlookUrl = `https://outlook.office.com/mail/deeplink/compose?bcc=${encodeURIComponent(batch.bcc)}&subject=${encodeURIComponent(batch.subject)}&body=${encodeURIComponent(batch.body)}`;
                                        const mailtoUrl = `mailto:?bcc=${encodeURIComponent(batch.bcc)}&subject=${encodeURIComponent(batch.subject)}&body=${encodeURIComponent(batch.body)}`;

                                        return (
                                            <div key={idx} className="bg-white/5 border border-green-500/20 rounded-xl p-4 text-left relative overflow-hidden">
                                                <div className="flex justify-between items-center mb-3 border-b border-gray-200/10 pb-2">
                                                    <span className="font-extrabold text-sm text-gray-200">
                                                        {batches.length > 1 ? `Batch ${idx + 1}` : "Email Draft Contents"}
                                                    </span>
                                                    <span className="text-xs text-gray-400 font-bold">
                                                        {batch.bcc.split(',').length} email addresses
                                                    </span>
                                                </div>

                                                {/* Copy Tools */}
                                                <div className="grid grid-cols-2 gap-2 mb-4">
                                                    <button
                                                        type="button"
                                                        onClick={() => handleCopyText(batch.bcc, 'bcc', idx)}
                                                        className={`flex items-center justify-center gap-2 py-1.5 px-3 rounded-lg text-xs font-bold transition-all active:scale-95 border ${copiedBccIdx === idx
                                                            ? 'bg-[#ff6188]/20 text-[#ff6188] border-[#ff6188]/30'
                                                            : 'bg-white/5 hover:bg-white/10 text-gray-200 border-gray-200/10'
                                                            }`}
                                                    >
                                                        {copiedBccIdx === idx ? <Check size={14} /> : <Copy size={14} />}
                                                        {copiedBccIdx === idx ? 'BCC Copied!' : 'Copy BCC List'}
                                                    </button>

                                                    <button
                                                        type="button"
                                                        onClick={() => handleCopyText(batch.body, 'body', idx)}
                                                        className={`flex items-center justify-center gap-2 py-1.5 px-3 rounded-lg text-xs font-bold transition-all active:scale-95 border ${copiedBodyIdx === idx
                                                            ? 'bg-[#ff6188]/20 text-[#ff6188] border-[#ff6188]/30'
                                                            : 'bg-white/5 hover:bg-white/10 text-gray-200 border-gray-200/10'
                                                            }`}
                                                    >
                                                        {copiedBodyIdx === idx ? <Check size={14} /> : <Copy size={14} />}
                                                        {copiedBodyIdx === idx ? 'Body Copied!' : 'Copy Body Content'}
                                                    </button>
                                                </div>

                                                {/* Outlook Helper Tooltip */}
                                                {outlookClickedIdx === idx && (
                                                    <div className="mb-3 p-2.5 bg-yellow-500/15 border border-yellow-500/30 text-yellow-450 text-xs rounded-lg font-bold animate-pulse flex items-center gap-1.5">
                                                        <AlertCircle size={14} className="text-yellow-500 flex-shrink-0" />
                                                        Outlook opened! Parent emails auto-copied—just press <strong>Ctrl+V</strong> (or <strong>Cmd+V</strong>) in the BCC field!
                                                    </div>
                                                )}

                                                {/* Action buttons */}
                                                <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                                                    <button onClick={() => openLink(gmailUrl)} className="flex items-center justify-center gap-2 py-2 px-3 bg-red-500/10 text-red-450 hover:bg-red-500/20 rounded-xl border border-red-500/20 text-sm font-bold transition-all active:scale-95">
                                                        <ExternalLink size={16} /> Gmail Web
                                                    </button>
                                                    <button
                                                        onClick={() => handleOutlookClick(outlookUrl, batch.bcc, idx)}
                                                        className="flex items-center justify-center gap-2 py-2 px-3 bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 rounded-xl border border-blue-500/20 text-sm font-bold transition-all active:scale-95"
                                                    >
                                                        <ExternalLink size={16} /> Outlook Web
                                                    </button>
                                                    <button onClick={() => openLink(mailtoUrl)} className="flex items-center justify-center gap-2 py-2 px-3 bg-white/5 text-gray-300 hover:bg-white/10 rounded-xl border border-gray-200/10 text-sm font-bold transition-all active:scale-95">
                                                        <Copy size={16} /> Default App
                                                    </button>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>

                            <div className="bg-[#ab9df2]/10 border-l-4 border-[#ab9df2] p-4 text-[#ab9df2] text-xs font-semibold rounded-r-xl">
                                <strong>💡 Tip:</strong> Because security configurations for Microsoft 365 or Gmail can sometimes hide or block automatic populating of the BCC field, clicking "Outlook Web" automatically copies the email addresses to your clipboard. Simply open the compose window, ensure the BCC field is visible, and press Paste (Ctrl+V) to paste the addresses to the BCC section!
                            </div>
                        </div>
                    )}
                </div>

                <div className="p-4 border-t bg-gray-50/5 flex justify-end gap-3">
                    {!draftGenerated ? (
                        <>
                            <button onClick={closeModal} className={`px-5 py-2 rounded-xl text-xs font-bold transition-all active:scale-95 ${themeClasses.btnSecondary}`}>Cancel</button>
                            <button onClick={generateDrafts} className={`px-5 py-2 rounded-xl text-xs font-bold transition-all active:scale-95 ${themeClasses.btnPrimary}`}>Proceed to Drafts</button>
                        </>
                    ) : (
                        <>
                            <button onClick={() => setDraftGenerated(false)} className={`px-5 py-2 rounded-xl text-xs font-bold transition-all active:scale-95 mr-auto ${themeClasses.btnSecondary}`}>Back</button>
                            <button onClick={handleComplete} className="px-6 py-2 bg-[#a9dc76] hover:bg-[#8ec35c] text-white font-bold rounded-xl shadow-md transition-all active:scale-95 flex items-center gap-2 text-xs">
                                <CheckSquare size={18} /> Mark as Logged
                            </button>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}