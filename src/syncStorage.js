// --- IndexedDB Sync Handle & Auto-Backup Storage ---
//
// Persisting a FileSystemFileHandle (and the automatic browser backups) needs
// IndexedDB, and the object store layout has changed over time:
//
//   v1 legacy  -> store "handles",        key "syncFileHandle"  (older builds)
//   current    -> store "sync_handles",   key "activeSyncHandle"
//                store "auto_backups"     (keyPath "id")
//
// Both layouts live in the same database, and IndexedDB only runs an upgrade
// when the database version changes. Opening at the version an older build
// already created means the new stores never appear, and any transaction on
// them throws "Failed to execute 'transaction' on 'IDBDatabase': One of the
// specified object stores was not found". We therefore migrate on upgrade and
// bump the version ourselves if we ever find a database with missing stores.

export const SYNC_DB_NAME = 'BatchEmailerSyncDB';
export const SYNC_DB_STORE = 'sync_handles';
export const SYNC_HANDLE_KEY = 'activeSyncHandle';
export const AUTO_BACKUP_STORE = 'auto_backups';

const LEGACY_SYNC_DB_STORE = 'handles';
const LEGACY_SYNC_HANDLE_KEY = 'syncFileHandle';
const REQUIRED_STORES = [SYNC_DB_STORE, AUTO_BACKUP_STORE];

let cachedConnection = null;

// Copy the file handle saved by older builds into the current store, then drop
// the legacy store. Runs inside the versionchange transaction of an upgrade.
function migrateLegacyHandle(db, tx) {
    if (!db.objectStoreNames.contains(LEGACY_SYNC_DB_STORE)) return;
    try {
        const dropLegacyStore = () => {
            try {
                db.deleteObjectStore(LEGACY_SYNC_DB_STORE);
            } catch {
                // Nothing to clean up if the store is already gone.
            }
        };
        const read = tx.objectStore(LEGACY_SYNC_DB_STORE).get(LEGACY_SYNC_HANDLE_KEY);
        read.onsuccess = () => {
            const legacyHandle = read.result;
            if (legacyHandle === undefined) {
                // Nothing worth keeping — drop the obsolete store.
                dropLegacyStore();
                return;
            }
            if (!db.objectStoreNames.contains(SYNC_DB_STORE)) return;
            try {
                const write = tx.objectStore(SYNC_DB_STORE).put(legacyHandle, SYNC_HANDLE_KEY);
                // Clean up only after the handle has been copied across.
                write.onsuccess = dropLegacyStore;
                write.onerror = () => console.warn('[Sync] Could not migrate the legacy sync file handle:', write.error);
            } catch (error) {
                console.warn('[Sync] Could not migrate the legacy sync file handle:', error);
            }
        };
        read.onerror = () => {
            console.warn('[Sync] Could not read the legacy sync file handle:', read.error);
        };
    } catch {
        // A failed migration must never abort the whole upgrade.
    }
}

function ensureStores(db, tx) {
    try {
        if (!db.objectStoreNames.contains(SYNC_DB_STORE)) {
            db.createObjectStore(SYNC_DB_STORE);
        }
        if (!db.objectStoreNames.contains(AUTO_BACKUP_STORE)) {
            db.createObjectStore(AUTO_BACKUP_STORE, { keyPath: 'id' });
        }
    } finally {
        migrateLegacyHandle(db, tx);
    }
}

function watchConnection(db) {
    // Let future upgrades through instead of blocking on this connection.
    db.onversionchange = () => {
        if (cachedConnection === db) cachedConnection = null;
        try {
            db.close();
        } catch {
            // Already closed.
        }
    };
    db.onclose = () => {
        if (cachedConnection === db) cachedConnection = null;
    };
    cachedConnection = db;
    return db;
}

/**
 * Open (and, if necessary, repair) the sync database.
 *
 * @param {object} [options]
 * @param {number|null} [options.version] Explicit version to open with (used to repair a stale layout).
 * @param {boolean} [options.allowRepair] Whether a database with missing stores may be upgraded.
 * @returns {Promise<IDBDatabase>}
 */
export function openSyncDB({ version = null, allowRepair = true } = {}) {
    return new Promise((resolve, reject) => {
        const factory = typeof indexedDB !== 'undefined' ? indexedDB : null;
        if (!factory) {
            reject(new Error('IndexedDB not supported'));
            return;
        }

        if (cachedConnection && !cachedConnection.closed
            && REQUIRED_STORES.every(store => cachedConnection.objectStoreNames.contains(store))) {
            resolve(cachedConnection);
            return;
        }

        let settled = false;
        const fail = (error) => {
            if (settled) return;
            settled = true;
            reject(error);
        };
        const succeed = (db) => {
            if (settled) return;
            settled = true;
            resolve(db);
        };

        // Never open with a lower version than the one already on disk, or the
        // browser rejects the request with a VersionError.
        const req = version ? factory.open(SYNC_DB_NAME, version) : factory.open(SYNC_DB_NAME);

        req.onupgradeneeded = (event) => ensureStores(event.target.result, event.target.transaction);
        req.onblocked = () => fail(new Error('Sync storage is busy in another tab — close the other tabs of this app and try again.'));
        req.onerror = () => fail(req.error || new Error('Could not open sync storage'));
        req.onsuccess = () => {
            const db = req.result;
            const missing = REQUIRED_STORES.filter(store => !db.objectStoreNames.contains(store));

            if (missing.length > 0) {
                db.close();
                if (allowRepair) {
                    // An older build created this database at the same version we just
                    // opened, so no upgrade ran. Bump the version to create the stores.
                    openSyncDB({ version: Math.floor(db.version) + 1, allowRepair: false }).then(succeed, fail);
                } else {
                    fail(new Error('Sync storage is missing its data stores — clear this site\'s data, then import your backup again.'));
                }
                return;
            }

            succeed(watchConnection(db));
        };
    });
}

/**
 * Close (and forget) the cached connection. The next storage call reopens it.
 * Useful on teardown; nothing else needs to manage connections by hand.
 */
export function closeSyncDB() {
    const db = cachedConnection;
    cachedConnection = null;
    if (!db) return;
    try {
        db.close();
    } catch {
        // Already closed.
    }
}

/**
 * Run `fn(db)` against a live connection. If the cached connection turns out to
 * be closed behind our back (the browser may drop it), reopen once and retry.
 */
async function withSyncDB(fn) {
    for (let attempt = 0; attempt < 2; attempt++) {
        const db = await openSyncDB();
        try {
            return await fn(db);
        } catch (error) {
            const connectionIsStale = cachedConnection === db && error && error.name === 'InvalidStateError';
            if (!connectionIsStale || attempt === 1) throw error;
            closeSyncDB();
        }
    }
    throw new Error('Sync storage is unavailable');
}

export async function getSyncHandle() {
    try {
        return await withSyncDB(db => new Promise((resolve, reject) => {
            const tx = db.transaction(SYNC_DB_STORE, 'readonly');
            const req = tx.objectStore(SYNC_DB_STORE).get(SYNC_HANDLE_KEY);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error || tx.error);
        }));
    } catch (error) {
        console.warn('[Sync] Could not read the saved sync file handle:', error);
        return null;
    }
}

export async function setSyncHandle(handle) {
    return withSyncDB(db => new Promise((resolve, reject) => {
        const tx = db.transaction(SYNC_DB_STORE, 'readwrite');
        tx.objectStore(SYNC_DB_STORE).put(handle, SYNC_HANDLE_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('Could not save the sync file handle'));
        tx.onabort = () => reject(tx.error || new Error('Could not save the sync file handle'));
    }));
}

export async function clearSyncHandle() {
    return withSyncDB(db => new Promise((resolve, reject) => {
        const tx = db.transaction(SYNC_DB_STORE, 'readwrite');
        tx.objectStore(SYNC_DB_STORE).delete(SYNC_HANDLE_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('Could not clear the sync file handle'));
        tx.onabort = () => reject(tx.error || new Error('Could not clear the sync file handle'));
    }));
}

export async function putAutoBackup(record) {
    return withSyncDB(db => new Promise((resolve, reject) => {
        const tx = db.transaction(AUTO_BACKUP_STORE, 'readwrite');
        tx.objectStore(AUTO_BACKUP_STORE).put(record);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('Could not write the automatic backup'));
        tx.onabort = () => reject(tx.error || new Error('Could not write the automatic backup'));
    }));
}
