import React, { useState, useEffect, useRef } from 'react';
import {
    Folder, Book, Trash2, Edit2, Mail, Download, Upload, Plus,
    CheckSquare, Square, X, Archive, FileText, Check, AlertCircle,
    Copy, ExternalLink, RefreshCw, FolderOpen, MoreVertical, Menu,
    ChevronDown, ChevronUp, Clock, History, Trash, Printer, FileSpreadsheet,
    Sun, Moon, Sparkles, Coffee, AlertTriangle, CheckCircle2, Cloud, CloudOff
} from 'lucide-react';

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
    let os = 'Unknown Device';
    if (/Macintosh|Mac OS X/i.test(ua)) os = 'Mac';
    else if (/Windows/i.test(ua)) os = 'Windows';
    else if (/Android/i.test(ua)) os = 'Android';
    else if (/iPhone|iPad|iPod/i.test(ua)) os = 'iOS';
    else if (/Linux/i.test(ua)) os = 'Linux';

    let browser = 'Browser';
    if (/Edg/i.test(ua)) browser = 'Edge';
    else if (/Chrome/i.test(ua)) browser = 'Chrome';
    else if (/Safari/i.test(ua)) browser = 'Safari';
    else if (/Firefox/i.test(ua)) browser = 'Firefox';

    return `${os} • ${browser}`;
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
const SYNC_DB_NAME = 'BatchEmailerSyncDB';
const SYNC_DB_STORE = 'sync_handles';
const SYNC_HANDLE_KEY = 'activeSyncHandle';
const AUTO_BACKUP_STORE = 'auto_backups';

function openSyncDB() {
    return new Promise((resolve, reject) => {
        if (!window.indexedDB) {
            reject(new Error("IndexedDB not supported"));
            return;
        }
        const req = indexedDB.open(SYNC_DB_NAME, 1);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(SYNC_DB_STORE)) {
                db.createObjectStore(SYNC_DB_STORE);
            }
            if (!db.objectStoreNames.contains(AUTO_BACKUP_STORE)) {
                db.createObjectStore(AUTO_BACKUP_STORE, { keyPath: 'id' });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function getSyncHandle() {
    try {
        const db = await openSyncDB();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(SYNC_DB_STORE, "readonly");
            const req = tx.objectStore(SYNC_DB_STORE).get(SYNC_HANDLE_KEY);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(tx.error);
        });
    } catch {
        return null;
    }
}

async function setSyncHandle(handle) {
    const db = await openSyncDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(SYNC_DB_STORE, "readwrite");
        tx.objectStore(SYNC_DB_STORE).put(handle, SYNC_HANDLE_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

async function clearSyncHandle() {
    const db = await openSyncDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(SYNC_DB_STORE, "readwrite");
        tx.objectStore(SYNC_DB_STORE).delete(SYNC_HANDLE_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

const saveAutoBackupToIDB = async (dataToSave) => {
    try {
        const db = await openSyncDB();
        const encrypted = await encryptExport(dataToSave);
        const tx = db.transaction(AUTO_BACKUP_STORE, 'readwrite');
        const store = tx.objectStore(AUTO_BACKUP_STORE);
        store.put({
            id: 'latest_auto_backup',
            timestamp: new Date().toISOString(),
            envelope: JSON.parse(encrypted)
        });
    } catch (err) {
        console.warn("Failed to write auto-backup to IndexedDB:", err);
    }
};

// --- Save File Helper with File System Access API & Fallback ---
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
            if (e.name === "AbortError") return null;
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
    return null;
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

// --- Generic, Robust Custom Local Storage Hook ---
function useLocalStorage(key, initialValue) {
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

    useEffect(() => {
        try {
            window.localStorage.setItem(key, JSON.stringify(storedValue));
        } catch (error) {
            console.warn(error);
        }
    }, [key, storedValue]);

    return [storedValue, setStoredValue];
}

// --- Main Application Component ---
export default function App() {
    // State
    const [data, setData] = useLocalStorage('batch-emailer-data', {
        folders: [],
        classes: [], // Internally classes, represented as "Groups" in UI
        students: [] // Internally students, represented as "Contacts" in UI
    });

    const [activeFolderId, setActiveFolderId] = useState(null);
    const [activeClassId, setActiveClassId] = useState(null);
    const [expandedFolders, setExpandedFolders] = useState({});
    const [showArchived, setShowArchived] = useState(false);
    const [sidebarOpen, setSidebarOpen] = useState(true);
    const [expandedStudents, setExpandedStudents] = useState([]);
    const [expandedEmailContacts, setExpandedEmailContacts] = useState([]);
    const [theme, setTheme] = useLocalStorage('batch-emailer-theme', 'dark'); // Defaulting to dark

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

    // Edit states
    const [editingItem, setEditingItem] = useState(null);
    const [selectedStudents, setSelectedStudents] = useState([]);
    const [lastSelectedStudentId, setLastSelectedStudentId] = useState(null);

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
                            id: generateId(),
                            timestamp: updatedStudent.timestamp || new Date().toISOString(),
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
    const [syncStatus, setSyncStatus] = useState('idle'); // 'idle' | 'syncing' | 'synced' | 'local-changes' | 'error'
    const [syncFileName, setSyncFileName] = useState('');
    const [showSyncConflictModal, setShowSyncConflictModal] = useState(false);
    const [syncConflictData, setSyncConflictData] = useState(null);
    const [showRestoreChoiceModal, setShowRestoreChoiceModal] = useState(false);
    const [pendingRestoreData, setPendingRestoreData] = useState(null);

    // Note local change for fast hash diffing
    const noteLocalChange = (updatedData) => {
        const meta = getSyncMeta();
        if (meta.baseFastHash && updatedData) {
            const currentFastHash = computeDataHashSync(getCanonicalData(updatedData));
            if (currentFastHash !== meta.baseFastHash) {
                setSyncStatus('local-changes');
            } else {
                setSyncStatus('synced');
            }
        }
    };

    // Automatic Browser Backup to IndexedDB on data changes + change tracking
    useEffect(() => {
        if (data) {
            noteLocalChange(data);
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
                if (meta.fileName) {
                    setSyncFileName(meta.fileName);
                }
                const handle = await getSyncHandle();
                if (handle) {
                    setSyncFileName(handle.name);
                }
                if (meta.baseFastHash && data) {
                    const currentFastHash = computeDataHashSync(getCanonicalData(data));
                    if (currentFastHash !== meta.baseFastHash) {
                        setSyncStatus('local-changes');
                    } else {
                        setSyncStatus('synced');
                    }
                } else {
                    setSyncStatus('idle');
                }
            } catch (err) {
                console.warn("Failed to initialize sync state:", err);
            }
        };
        initSync();
    }, []);

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
            target.closest('.select-all') ||
            target.closest('svg')
        ) {
            return;
        }

        const orderedIds = classStudents.map(s => s.id);
        const targetIndex = orderedIds.indexOf(studentId);
        let newSelection = [...selectedStudents];

        if (e.shiftKey && lastSelectedStudentId && orderedIds.includes(lastSelectedStudentId)) {
            const lastIndex = orderedIds.indexOf(lastSelectedStudentId);
            const start = Math.min(lastIndex, targetIndex);
            const end = Math.max(lastIndex, targetIndex);
            const rangeIds = orderedIds.slice(start, end + 1);

            // Combines range with current selection by default
            newSelection = Array.from(new Set([...selectedStudents, ...rangeIds]));
        } else {
            // Act as if ctrl/meta key is held by default: toggle the selection
            if (selectedStudents.includes(studentId)) {
                newSelection = selectedStudents.filter(id => id !== studentId);
            } else {
                newSelection = [...selectedStudents, studentId];
            }
            setLastSelectedStudentId(studentId);
        }

        setSelectedStudents(newSelection);
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

    const handleBulkAdd = (e) => {
        e.preventDefault();
        const rawData = e.target.bulkData.value;
        const rows = rawData.split('\n');
        const newStudents = [];

        rows.forEach(row => {
            const cols = row.split('\t');
            if (cols.length > 0 && cols[0].trim() !== '') {
                const name = cols[0].trim();
                const emails = [];
                let notes = '';

                // Intelligently scan remaining columns for emails (presence of @ symbol)
                for (let i = 1; i < cols.length; i++) {
                    const val = cols[i].trim();
                    if (val.includes('@')) {
                        emails.push(val);
                    } else if (val !== '') {
                        notes = val;
                    }
                }

                newStudents.push({
                    id: generateId(),
                    classId: activeClassId,
                    name: name,
                    emails: emails.length > 0 ? emails : [''],
                    notes: notes,
                    timestamp: '',
                    message: '',
                    emailHistory: []
                });
            }
        });

        if (newStudents.length > 0) {
            setData(prev => ({
                ...prev,
                students: [...prev.students, ...newStudents]
            }));
        }
        closeModals();
    };

    const deleteStudent = (id) => {
        showConfirm("Delete Contact", "Are you sure you want to delete this contact?", () => {
            setData(prev => ({
                ...prev,
                students: prev.students.filter(s => s.id !== id)
            }));
            setSelectedStudents(prev => prev.filter(sId => sId !== id));
            setExpandedStudents(prev => prev.filter(sId => sId !== id));
            setExpandedEmailContacts(prev => prev.filter(sId => sId !== id));
            closeModals();
        });
    };

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

    const normalizeImportedData = (importedData) => {
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
                        id: generateId(),
                        timestamp: updatedStudent.timestamp || new Date().toISOString(),
                        message: updatedStudent.message || ''
                    });
                }
                updatedStudent.emailHistory = history;
            }
            return updatedStudent;
        });

        return { folders, classes, students };
    };

    const buildSyncJSON = async (revision = 1, currentData = null) => {
        const activeData = currentData || data;
        const canonicalData = getCanonicalData(activeData);
        const contentHash = await computeDataHash(canonicalData);
        const meta = getSyncMeta();
        const rev = Number.isFinite(revision) ? revision : ((meta.baseRevision || 0) + 1);

        const payload = {
            version: 2,
            exportedAt: new Date().toISOString(),
            syncMeta: {
                schemaVersion: 2,
                revision: rev,
                timestamp: Date.now(),
                deviceId: getDeviceId(),
                deviceName: getDeviceName(),
                contentHash: contentHash,
                summary: {
                    folderCount: (activeData.folders || []).length,
                    classCount: (activeData.classes || []).length,
                    studentCount: (activeData.students || []).length
                }
            },
            folders: activeData.folders || [],
            classes: activeData.classes || [],
            students: activeData.students || []
        };

        const jsonStr = await encryptExport(payload);
        return { jsonStr, payload, canonicalData, contentHash, revision: rev };
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
        const writable = await handle.createWritable();
        await writable.write(jsonStr);
        await writable.close();

        const fastHash = computeDataHashSync(canonicalData);
        setSyncMeta({
            fileName: handle.name,
            baseRevision: revision,
            lastSyncedRevision: revision,
            baseContentHash: contentHash,
            lastSyncedContentHash: contentHash,
            baseFastHash: fastHash,
            lastSyncedAt: Date.now()
        });
        setSyncFileName(handle.name);
        setSyncStatus('synced');
        return true;
    };

    const executeSyncResolution = async ({ parsed, file, handle = null, currentData = null, onPushRequired = null }) => {
        const activeData = currentData || data;
        const meta = getSyncMeta();
        const localCanonical = getCanonicalData(activeData);
        const localHash = await computeDataHash(localCanonical);

        const fileNormalized = normalizeImportedData(parsed);
        const fileCanonical = getCanonicalData(fileNormalized);
        const fileHash = await computeDataHash(fileCanonical);
        const fileMeta = parsed?.syncMeta || null;
        const fileRevision = Number.isFinite(fileMeta?.revision) ? fileMeta.revision : 1;
        const fileName = file?.name || meta.fileName || "batch_emailer_sync.json";

        // Case 0: Hashes identical
        if (fileHash && localHash === fileHash) {
            setSyncMeta({
                fileName,
                lastSyncedRevision: fileRevision,
                lastSyncedContentHash: localHash,
                baseRevision: fileRevision,
                baseContentHash: localHash,
                baseFastHash: computeDataHashSync(localCanonical),
                lastSyncedAt: Date.now()
            });
            setSyncFileName(fileName);
            setSyncStatus('synced');
            showAlert("In Sync", "Local data and sync file are already identical.");
            return;
        }

        // Case 1: Initial setup where one side is empty
        const localEmpty = activeData.folders.length === 0 && activeData.classes.length === 0 && activeData.students.length === 0;
        const fileEmpty = fileNormalized.folders.length === 0 && fileNormalized.classes.length === 0 && fileNormalized.students.length === 0;

        if (localEmpty && !fileEmpty) {
            setData(fileNormalized);
            setActiveFolderId(null);
            setActiveClassId(null);
            setSyncMeta({
                fileName,
                baseRevision: fileRevision,
                lastSyncedRevision: fileRevision,
                baseContentHash: fileHash,
                lastSyncedContentHash: fileHash,
                baseFastHash: computeDataHashSync(fileCanonical),
                lastSyncedAt: Date.now()
            });
            setSyncFileName(fileName);
            setSyncStatus('synced');
            showAlert("Sync Complete", `Loaded data from ${fileName}.`);
            return;
        }

        if (!localEmpty && fileEmpty) {
            if (handle) {
                await pushToHandle(handle, 1, activeData);
            } else if (onPushRequired) {
                await onPushRequired(1);
            }
            setSyncFileName(fileName);
            setSyncStatus('synced');
            showAlert("Sync Complete", `Initial sync saved to ${fileName}.`);
            return;
        }

        // Case 2: 3-Way check against base
        const baseHash = meta.baseContentHash || null;
        const localChanged = baseHash ? (localHash !== baseHash) : true;
        const fileChanged = baseHash ? (fileHash !== baseHash) : true;

        if (!localChanged && fileChanged) {
            // Silent Pull
            setData(fileNormalized);
            setActiveFolderId(null);
            setActiveClassId(null);
            setSyncMeta({
                fileName,
                baseRevision: fileRevision,
                lastSyncedRevision: fileRevision,
                baseContentHash: fileHash,
                lastSyncedContentHash: fileHash,
                baseFastHash: computeDataHashSync(fileCanonical),
                lastSyncedAt: Date.now()
            });
            setSyncFileName(fileName);
            setSyncStatus('synced');
            showAlert("Sync Complete", `Updated local data from ${fileName}.`);
        } else if (localChanged && !fileChanged) {
            // Silent Push
            const nextRev = (meta.baseRevision || 0) + 1;
            if (handle) {
                await pushToHandle(handle, nextRev, activeData);
            } else if (onPushRequired) {
                await onPushRequired(nextRev);
            }
            setSyncFileName(fileName);
            setSyncStatus('synced');
            showAlert("Sync Complete", `Saved your latest changes to ${fileName}.`);
        } else {
            // True Conflict (or first sync with data on both sides)
            const localFP = generateDataFingerprint(activeData);
            const fileFP = generateDataFingerprint(fileNormalized);
            const comparison = compareFingerprints(localFP, fileFP);

            setSyncConflictData({
                comparison,
                parsed: fileNormalized,
                fileRevision,
                fileHash,
                fileCanonical,
                handle,
                onPushRequired,
                fileName
            });
            setShowSyncConflictModal(true);
        }
    };

    const handleSync = async () => {
        setSyncStatus('syncing');
        try {
            if (window.showOpenFilePicker) {
                // File System Access API supported (Chrome, Edge, Arc)
                let handle = await getSyncHandle();
                let needPick = !handle;

                if (handle) {
                    try {
                        if (handle.queryPermission) {
                            let perm = await handle.queryPermission({ mode: 'readwrite' });
                            if (perm !== 'granted') {
                                perm = await handle.requestPermission({ mode: 'readwrite' });
                            }
                            if (perm !== 'granted') needPick = true;
                        }
                    } catch {
                        needPick = true;
                    }
                }

                if (needPick) {
                    const pickerHandles = await window.showOpenFilePicker({
                        multiple: false,
                        types: [{ description: "JSON Sync File", accept: { "application/json": [".json"] } }]
                    });
                    handle = pickerHandles[0];
                    if (!handle) {
                        setSyncStatus('idle');
                        return;
                    }
                    await setSyncHandle(handle);
                }

                const file = await handle.getFile();
                const text = await file.text();
                const parsed = await parseExport(text);
                await executeSyncResolution({ parsed, file, handle, currentData: data });
            } else {
                // Non-FSA fallback (Safari, Firefox, Mobile)
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = '.json';
                input.onchange = async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) {
                        setSyncStatus('idle');
                        return;
                    }
                    try {
                        const text = await file.text();
                        const parsed = await parseExport(text);
                        await executeSyncResolution({
                            parsed,
                            file,
                            handle: null,
                            currentData: data,
                            onPushRequired: async (nextRev) => {
                                const { jsonStr } = await buildSyncJSON(nextRev, data);
                                await saveFileAs(jsonStr, file.name || "batch_emailer_sync.json");
                            }
                        });
                    } catch (err) {
                        console.error("Sync error:", err);
                        setSyncStatus('error');
                        showAlert("Sync Error", "Failed to parse sync file: " + (err.message || err));
                    }
                };
                input.click();
            }
        } catch (err) {
            if (err.name !== 'AbortError') {
                console.error("Sync failed:", err);
                setSyncStatus('error');
                showAlert("Sync Failed", "Could not complete sync: " + (err.message || err));
            } else {
                setSyncStatus('idle');
            }
        }
    };

    const handleDisconnectSync = async () => {
        showConfirm("Disconnect Sync", "Disconnecting will stop syncing with this file. Your local data will remain unchanged.", async () => {
            await clearSyncHandle();
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

            // Mobile Native Web Share API
            if (navigator.share && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)) {
                try {
                    const blob = new Blob([jsonStr], { type: "application/json" });
                    const file = new File([blob], filename, { type: "application/json" });
                    if (navigator.canShare && navigator.canShare({ files: [file] })) {
                        await navigator.share({ files: [file] });
                        return;
                    }
                } catch {
                    // fall through to saveFileAs
                }
            }

            await saveFileAs(jsonStr, filename, "application/json");
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
        const { normalized, raw, fileName } = pendingRestoreData;
        const canonical = getCanonicalData(normalized);
        const hash = await computeDataHash(canonical);
        const fastHash = computeDataHashSync(canonical);
        const fileRev = Number.isFinite(raw.syncMeta?.revision) ? raw.syncMeta.revision : 1;

        setData(normalized);
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
        const newStudents = normalized.students.filter(s => !existingStudentIds.has(s.id));

        if (newFolders.length === 0 && newClasses.length === 0 && newStudents.length === 0) {
            setShowRestoreChoiceModal(false);
            setPendingRestoreData(null);
            closeModals();
            showAlert("Import Complete", "No new items found. All items in the backup already exist in your local data.");
            return;
        }

        const merged = {
            folders: [...data.folders, ...newFolders],
            classes: [...data.classes, ...newClasses],
            students: [...data.students, ...newStudents]
        };

        setData(merged);
        noteLocalChange(merged);

        setShowRestoreChoiceModal(false);
        setPendingRestoreData(null);
        closeModals();
        showAlert("Import Complete", `Successfully imported ${newFolders.length} new folders, ${newClasses.length} new groups, and ${newStudents.length} new contacts.`);
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

                    {/* Theme Selector Widget */}
                    <div className="flex items-center gap-2">
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
                                        <th className="p-3 w-16 text-center"></th>
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
                                                >
                                                    <td className="p-3 text-center">
                                                        <input
                                                            type="checkbox"
                                                            checked={isSelected}
                                                            onChange={() => { }} // Controlled via onClick on tr
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
                                                        <button onClick={() => openEditModal('student', student)} className={`p-1.5 rounded-lg border transition-all duration-200 active:scale-95 ${isDark ? 'text-zinc-400 hover:text-[#ff6188] hover:bg-zinc-800 border-zinc-700' : 'text-gray-500 hover:text-[#ff6188] hover:bg-gray-100 border-gray-200'
                                                            }`}><Edit2 size={16} /></button>
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
                    onImportPaste={handleBulkAdd}
                    onImportCSV={(csvStudents) => {
                        if (csvStudents.length > 0) {
                            const formatted = csvStudents.map(s => ({
                                id: generateId(),
                                classId: activeClassId,
                                name: s.name,
                                emails: s.emails,
                                notes: s.notes || '',
                                timestamp: '',
                                message: '',
                                emailHistory: []
                            }));
                            setData(prev => ({
                                ...prev,
                                students: [...prev.students, ...formatted]
                            }));
                        }
                        closeModals();
                    }}
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
                                <div className="flex gap-2">
                                    <button
                                        onClick={() => { handleSync(); setModals({ ...modals, backup: false }); }}
                                        disabled={syncStatus === 'syncing'}
                                        className={`flex-1 py-2.5 rounded-lg text-xs font-bold transition-all active:scale-95 flex items-center justify-center gap-1.5 ${syncStatus === 'syncing' ? 'opacity-50 cursor-not-allowed' : ''} ${themeClasses.btnPrimary}`}
                                    >
                                        <RefreshCw size={13} className={syncStatus === 'syncing' ? 'animate-spin' : ''} />
                                        {syncStatus === 'syncing' ? 'Syncing…' : 'Sync Now'}
                                    </button>
                                    {syncFileName && (
                                        <button
                                            onClick={handleDisconnectSync}
                                            className={`py-2.5 px-3 rounded-lg text-xs font-bold transition-all active:scale-95 flex items-center gap-1 ${isDark ? 'bg-rose-500/10 text-rose-400 hover:bg-rose-500/20' : 'bg-rose-50 text-rose-600 hover:bg-rose-100'}`}
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
                                    Saves an encrypted backup file to your device. Can be used as a sync file — interchangeable formats.
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
                                    Load a backup or sync file. You'll choose whether to replace all data or import only new items.
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
                    onLogMessage={(message) => {
                        const timestamp = new Date().toISOString();
                        setData(prev => ({
                            ...prev,
                            students: prev.students.map(s => {
                                if (selectedStudents.includes(s.id)) {
                                    const currentHistory = s.emailHistory || [];
                                    const newLog = {
                                        id: generateId(),
                                        timestamp,
                                        message
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
                                <span className={`block text-[10px] font-normal mt-0.5 ${themeClasses.textMuted}`}>Only adds items not already in your data</span>
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

        </div>
    );
}

// --- Import Contacts Sub-Component ---
function ImportContactsModal({ onImportPaste, onImportCSV, closeModal, themeClasses }) {
    const [activeTab, setActiveTab] = useState('paste'); // 'paste' | 'csv'
    const [csvPreview, setCsvPreview] = useState([]);
    const [csvFileName, setCsvFileName] = useState('');
    const fileInputRef = useRef(null);
    const isDark = themeClasses.textPrimary.includes('text-[#fcfaf2]');

    const handleFileChange = (e) => {
        const file = e.target.files[0];
        if (!file) return;

        setCsvFileName(file.name);
        const reader = new FileReader();
        reader.onload = (event) => {
            const text = event.target.result;
            const rawRows = parseCSV(text);
            const parsedContacts = [];

            // Identify header index values if any, else assume standard columns
            let startIdx = 0;
            if (rawRows.length > 0 && (rawRows[0][0]?.toLowerCase().includes('name') || rawRows[0][1]?.toLowerCase().includes('email'))) {
                startIdx = 1; // Skip header row
            }

            for (let i = startIdx; i < rawRows.length; i++) {
                const row = rawRows[i];
                if (row.length > 0 && row[0]?.trim() !== '') {
                    const name = row[0].trim();
                    const emails = [];
                    let notes = '';

                    for (let j = 1; j < row.length; j++) {
                        const val = row[j]?.trim() || '';
                        if (val.includes('@')) {
                            emails.push(val);
                        } else if (val !== '') {
                            notes = val;
                        }
                    }

                    parsedContacts.push({
                        name,
                        emails: emails.length > 0 ? emails : [''],
                        notes
                    });
                }
            }

            setCsvPreview(parsedContacts);
        };
        reader.readAsText(file);
    };

    return (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4 backdrop-blur-xs">
            <div className={`rounded-2xl shadow-xl w-full max-w-2xl overflow-hidden flex flex-col h-[80vh] border animate-in fade-in zoom-in-95 duration-200 ${themeClasses.cardBg}`}>
                <div className="p-4 border-b flex justify-between items-center bg-gray-50/5">
                    <h3 className={`font-bold text-lg ${isDark ? 'text-[#78dce8]' : 'text-[#00838f]'}`}>Import Contacts</h3>
                    <button onClick={closeModal} className="text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-500/10 transition-colors"><X size={20} /></button>
                </div>

                {/* Tab Controls */}
                <div className="flex border-b border-gray-200/10">
                    <button
                        type="button"
                        onClick={() => setActiveTab('paste')}
                        className={`flex-1 py-3 text-center text-sm font-bold border-b-2 transition-all ${activeTab === 'paste' ? 'border-[#ff6188] text-[#ff6188] bg-[#ff6188]/5' : 'border-transparent text-gray-400 hover:text-gray-200'}`}
                    >
                        Paste Spreadsheet Rows
                    </button>
                    <button
                        type="button"
                        onClick={() => setActiveTab('csv')}
                        className={`flex-1 py-3 text-center text-sm font-bold border-b-2 transition-all ${activeTab === 'csv' ? 'border-b-[#ff6188] text-[#ff6188] bg-[#ff6188]/5' : 'border-transparent text-gray-400 hover:text-gray-200'}`}
                    >
                        Upload CSV File
                    </button>
                </div>

                <div className="flex-1 flex flex-col p-5 overflow-hidden min-h-0">
                    {activeTab === 'paste' ? (
                        <form onSubmit={onImportPaste} className="flex-1 flex flex-col min-h-0">
                            <div className="bg-[#ff6188]/10 border border-[#ff6188]/20 text-[#ff6188] p-3 rounded-xl text-xs mb-4 leading-relaxed font-semibold">
                                <strong>Copy/Paste Rows:</strong> Copy rows directly from Excel or Google Sheets and paste them below.
                                Ensure your first column is the <strong>Name</strong>. Any subsequent columns containing an <code>@</code> symbol will automatically be captured as additional email addresses!
                            </div>
                            <textarea
                                required
                                autoFocus
                                name="bulkData"
                                className="w-full flex-1 border border-gray-200/10 rounded-xl p-3.5 font-mono text-sm focus:ring-2 focus:ring-[#ff6188] outline-none whitespace-pre overflow-auto bg-gray-500/5 text-[#fcfaf2] dark:text-[#fcfaf2]"
                                placeholder={`Alex Smith\tsarah.smith@example.com\tparent@example.com\tMother: Sarah Smith&#10;Emily Davis\tpeter.davis@example.com\t\tFather: Peter`}
                            />
                            <div className="flex justify-end gap-2 pt-4 mt-4 border-t border-gray-200/10">
                                <button type="button" onClick={closeModal} className={`px-4 py-2 rounded-lg text-xs font-bold transition-all ${themeClasses.btnSecondary}`}>Cancel</button>
                                <button type="submit" className={`px-4 py-2 rounded-lg text-xs font-bold transition-all ${themeClasses.btnPrimary}`}>Import Data</button>
                            </div>
                        </form>
                    ) : (
                        <div className="flex-1 flex flex-col min-h-0">
                            <div className="bg-[#78dce8]/10 border border-[#78dce8]/20 text-[#78dce8] p-3 rounded-xl text-xs mb-4 leading-relaxed font-semibold">
                                <strong>Upload CSV:</strong> Select a standard comma-separated `.csv` file. The local parser scans column values: the first populated cell is the name, columns containing <code>@</code> are imported as emails, and other cells map to notes.
                            </div>

                            <div className="flex flex-col items-center justify-center p-8 border-2 border-dashed border-gray-300/30 rounded-2xl hover:bg-gray-500/5 transition-all mb-4 cursor-pointer" onClick={() => fileInputRef.current.click()}>
                                <FileSpreadsheet size={40} className="text-gray-400 mb-2 animate-bounce" />
                                <span className="text-sm font-bold text-gray-300 text-center">
                                    {csvFileName ? `Selected: ${csvFileName}` : 'Click to upload or select a CSV file'}
                                </span>
                                <input
                                    type="file"
                                    ref={fileInputRef}
                                    accept=".csv"
                                    className="hidden"
                                    onChange={handleFileChange}
                                />
                            </div>

                            {csvPreview.length > 0 && (
                                <div className="flex-1 flex flex-col min-h-0 animate-in fade-in duration-300">
                                    <h4 className="font-extrabold text-xs text-gray-400 uppercase tracking-wider mb-2">Import Preview ({csvPreview.length} contacts found):</h4>
                                    <div className="border border-gray-200/10 rounded-xl overflow-y-auto flex-1 bg-gray-500/5 p-2 space-y-1">
                                        {csvPreview.slice(0, 10).map((p, idx) => (
                                            <div key={idx} className="bg-white/5 p-2.5 rounded-lg border border-gray-200/5 flex justify-between text-xs items-center font-medium">
                                                <span className="font-bold">{p.name}</span>
                                                <span className="text-gray-400 truncate max-w-[300px]">{p.emails.filter(Boolean).join(', ')}</span>
                                            </div>
                                        ))}
                                        {csvPreview.length > 10 && (
                                            <div className="text-center text-xs text-gray-400 py-1 font-bold">
                                                + {csvPreview.length - 10} more rows
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )}

                            <div className="flex justify-end gap-2 pt-4 mt-auto border-t border-gray-200/10">
                                <button type="button" onClick={closeModal} className={`px-4 py-2 rounded-lg text-xs font-bold transition-all ${themeClasses.btnSecondary}`}>Cancel</button>
                                <button
                                    type="button"
                                    disabled={csvPreview.length === 0}
                                    onClick={() => onImportCSV(csvPreview)}
                                    className={`px-5 py-2 rounded-lg text-xs font-bold transition-all active:scale-95 ${csvPreview.length > 0 ? themeClasses.btnPrimary : 'bg-gray-200 text-gray-400 cursor-not-allowed shadow-none'
                                        }`}
                                >
                                    Import {csvPreview.length} Contacts
                                </button>
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
        onLogMessage(message);
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