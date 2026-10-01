// Proves that backup/sync files really do contain everything the app stores.
//
//   npm run verify-backup
//
// It bundles the module-level helpers out of src/App.jsx (JSX included), then
// checks that:
//   1. a realistic dataset round-trips through encrypt → write → read → verify
//   2. verification FAILS if email messages are dropped from the file
//   3. verification FAILS if the contacts array is missing
//   4. importing keeps every field (including log subjects)
//   5. "Import New Items Only" merging never discards a message
//   6. drag & drop order and subfolder nesting survive the file and its hash

import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// --- Bundle the app's helpers into a loadable module -------------------------
const outDir = await mkdtemp(path.join(tmpdir(), 'batch-emailer-verify-'));
const outFile = path.join(outDir, 'app.mjs');

try {
    await build({
        entryPoints: [path.join(root, 'src', 'App.jsx')],
        bundle: true,
        format: 'esm',
        platform: 'node',
        outfile: outFile,
        logLevel: 'error'
    });

    // Browser globals the helpers touch.
    const memory = new Map();
    globalThis.localStorage = {
        getItem: (key) => (memory.has(key) ? memory.get(key) : null),
        setItem: (key, value) => memory.set(key, String(value)),
        removeItem: (key) => memory.delete(key)
    };
    globalThis.screen ??= { width: 0 };
    try {
        Object.defineProperty(globalThis, 'navigator', {
            value: { userAgent: 'verify-backup-script' },
            configurable: true
        });
    } catch {
        // Node ships its own navigator — good enough.
    }
    localStorage.setItem('batch-emailer-theme', 'light');

    const app = await import(pathToFileURL(outFile).href);
    const {
        encryptExport, parseExport, normalizeImportedData,
        buildBackupPayload, verifyBackupRoundTrip, getDataSummary,
        describeDataSummary, countEmailMessages, mergeContactRecords,
        getCanonicalData
    } = app;

    // --- A realistic dataset, including legacy fields and log subjects -------
    const dataset = {
        folders: [
            { id: 'f1', name: 'Homeroom', isArchived: false, createdAt: '2026-01-01T00:00:00.000Z' },
            { id: 'f2', name: 'Clubs', isArchived: true, createdAt: '2026-01-02T00:00:00.000Z' }
        ],
        classes: [
            { id: 'g1', folderId: 'f1', name: 'Period 1', isArchived: false, createdAt: '2026-01-03T00:00:00.000Z' },
            { id: 'g2', folderId: 'f2', name: 'Chess', isArchived: false, createdAt: '2026-01-04T00:00:00.000Z' },
            { id: 'g3', folderId: null, name: 'Loose contacts', isArchived: false, createdAt: '2026-01-05T00:00:00.000Z' }
        ],
        students: [
            {
                id: 's1', classId: 'g1', name: 'Alice Adams',
                emails: ['alice@example.com', 'parent@example.com'],
                notes: 'Mom calls on Fridays',
                timestamp: '2026-09-20T10:00:00.000Z',
                message: 'Second message body',
                emailHistory: [
                    { id: 'h2', timestamp: '2026-09-20T10:00:00.000Z', subject: 'Trip reminder', message: 'Second message body' },
                    { id: 'h1', timestamp: '2026-09-01T09:00:00.000Z', subject: 'Welcome back', message: 'First message body' }
                ]
            },
            {
                id: 's2', classId: 'g2', name: 'Bob Barnes',
                emails: ['bob@example.com'], notes: '',
                timestamp: '', message: '', emailHistory: []
            },
            {
                // Legacy contact that has never been migrated.
                id: 's3', classId: 'g1', name: 'Carol Chen',
                email1: 'carol@example.com', email2: '',
                timestamp: '2026-08-15T08:00:00.000Z', message: 'Legacy body'
            },
            {
                id: 's4', classId: 'g3', name: 'Dan Diaz',
                emails: [''], notes: 'No email yet',
                timestamp: '', message: '', emailHistory: []
            }
        ]
    };

    const expected = getDataSummary(dataset);
    assert.equal(expected.folderCount, 2, 'fixture folders');
    assert.equal(expected.classCount, 3, 'fixture groups');
    assert.equal(expected.studentCount, 4, 'fixture contacts');
    assert.equal(expected.messageCount, 3, 'fixture messages (2 real + 1 legacy)');

    // --- 1. A complete backup round-trips ------------------------------------
    const payload = await buildBackupPayload(dataset, 7);
    assert.equal(payload.version, 2, 'file format version');
    assert.equal(payload.settings.theme, 'light', 'settings travel with the backup');
    assert.equal(payload.syncMeta.summary.messageCount, 3, 'summary counts messages');

    const jsonStr = await encryptExport(payload);
    const verified = await verifyBackupRoundTrip(jsonStr, dataset, payload.settings);
    assert.deepEqual(verified, expected, 'verified summary matches the source data');

    const roundTripped = normalizeImportedData(await parseExport(jsonStr));
    assert.deepEqual(roundTripped.students[0].emailHistory, dataset.students[0].emailHistory,
        'email messages (and their subject lines) survive the file');
    assert.equal(roundTripped.students[2].emailHistory[0].message, 'Legacy body',
        'legacy message text is imported into the history');
    assert.deepEqual(roundTripped, normalizeImportedData(dataset),
        'what you read back equals what you started with');

    // --- 2. Verification fails when messages are missing ---------------------
    const withoutMessages = JSON.parse(JSON.stringify(payload));
    withoutMessages.students[0].emailHistory = [];
    await assert.rejects(
        async () => verifyBackupRoundTrip(await encryptExport(withoutMessages), dataset, payload.settings),
        /messageCount/,
        'dropped messages must fail verification'
    );

    // --- 3. Verification fails when the contacts array is missing ------------
    const withoutStudents = JSON.parse(JSON.stringify(payload));
    delete withoutStudents.students;
    await assert.rejects(
        async () => verifyBackupRoundTrip(await encryptExport(withoutStudents), dataset, payload.settings),
        /studentCount/,
        'a file without contacts must fail verification'
    );

    // --- 4. Verification fails when settings are lost ------------------------
    const withoutSettings = JSON.parse(JSON.stringify(payload));
    delete withoutSettings.settings;
    await assert.rejects(
        async () => verifyBackupRoundTrip(await encryptExport(withoutSettings), dataset, payload.settings),
        /settings/i,
        'lost settings must fail verification'
    );

    // --- 5. Merging never discards a message --------------------------------
    const local = {
        id: 's1', classId: 'g1', name: 'Alice Adams',
        emails: ['alice@example.com'], notes: 'Local note',
        timestamp: '2026-09-01T09:00:00.000Z', message: 'First message body',
        emailHistory: [{ id: 'h1', timestamp: '2026-09-01T09:00:00.000Z', subject: 'Welcome back', message: 'First message body' }]
    };
    const file = {
        id: 's1', classId: 'g1', name: 'Alice Adams',
        emails: ['alice@example.com', 'alice.work@example.com'], notes: '',
        timestamp: '2026-09-20T10:00:00.000Z', message: 'Second message body',
        emailHistory: [
            { id: 'h1', timestamp: '2026-09-01T09:00:00.000Z', subject: 'Welcome back', message: 'First message body' },
            { id: 'h2', timestamp: '2026-09-20T10:00:00.000Z', subject: 'Trip reminder', message: 'Second message body' }
        ]
    };
    const merged = mergeContactRecords(local, file);
    assert.equal(merged.emailHistory.length, 2, 'merge keeps both messages and drops the duplicate');
    assert.equal(merged.emailHistory[0].id, 'h2', 'newest message first');
    assert.equal(merged.name, 'Alice Adams', 'local name kept');
    assert.equal(merged.notes, 'Local note', 'local notes kept');
    assert.deepEqual(merged.emails, ['alice@example.com', 'alice.work@example.com'], 'new addresses appended');
    assert.equal(countEmailMessages({ students: [merged] }), 2, 'merged contact reports both messages');

    const localOnly = mergeContactRecords(local, { ...file, emailHistory: [] });
    assert.equal(localOnly.emailHistory.length, 1, 'an empty file history cannot erase local messages');

    // --- 6. Drag & drop order and subfolder nesting survive the file --------
    // The sidebar lets the user arrange folders and groups freely (and file a
    // folder inside another one). That arrangement lives in the array order
    // plus `parentId`, so the file has to write it back verbatim — a sort
    // anywhere in the pipeline would erase the layout on the next restore.
    const arranged = {
        folders: [
            { id: 'f2', name: 'Clubs', isArchived: true, parentId: null, createdAt: '2026-01-02T00:00:00.000Z' },
            { id: 'f4', name: 'Chess club', isArchived: false, parentId: 'f2', createdAt: '2026-01-06T00:00:00.000Z' },
            { id: 'f1', name: 'Homeroom', isArchived: false, parentId: null, createdAt: '2026-01-01T00:00:00.000Z' }
        ],
        classes: [
            { id: 'g3', folderId: null, name: 'Loose contacts', isArchived: false, createdAt: '2026-01-05T00:00:00.000Z' },
            { id: 'g1', folderId: 'f4', name: 'Period 1', isArchived: false, createdAt: '2026-01-03T00:00:00.000Z' },
            { id: 'g2', folderId: 'f2', name: 'Chess', isArchived: false, createdAt: '2026-01-04T00:00:00.000Z' }
        ],
        students: dataset.students
    };

    const arrangedPayload = await buildBackupPayload(arranged, 8);
    const arrangedJson = await encryptExport(arrangedPayload);
    const arrangedBack = normalizeImportedData(await parseExport(arrangedJson));
    assert.deepEqual(arrangedBack.folders.map(f => f.id), ['f2', 'f4', 'f1'],
        'folder order as dragged is written to the file and read back unchanged');
    assert.deepEqual(arrangedBack.classes.map(c => c.id), ['g3', 'g1', 'g2'],
        'group order as dragged is written to the file and read back unchanged');
    assert.equal(arrangedBack.folders[1].parentId, 'f2', 'subfolder nesting travels in the file');
    assert.equal(arrangedBack.folders[0].parentId, null, 'a top-level folder stays top level');
    await verifyBackupRoundTrip(arrangedJson, arranged, arrangedPayload.settings);
    assert.equal(
        describeDataSummary(arranged),
        describeDataSummary(normalizeImportedData(await parseExport(await encryptExport(
            await buildBackupPayload(arranged, 9)
        )))),
        'summary still matches after a reorder round-trip'
    );

    // The content hash has to see the arrangement too, otherwise a reorder
    // would never mark the data dirty and would never reach the other device.
    const arrangedHash = JSON.stringify(getCanonicalData(arranged));
    const reshuffled = { ...arranged, folders: [...arranged.folders].reverse(), classes: [...arranged.classes].reverse() };
    assert.notEqual(JSON.stringify(getCanonicalData(reshuffled)), arrangedHash,
        'reordering folders or groups changes the content hash');
    const reparented = { ...arranged, folders: arranged.folders.map(f => (f.id === 'f4' ? { ...f, parentId: 'f1' } : f)) };
    assert.notEqual(JSON.stringify(getCanonicalData(reparented)), arrangedHash,
        'moving a subfolder under a different parent changes the content hash');

    // --- Human readable summary ---------------------------------------------
    const line = describeDataSummary(dataset);
    assert.match(line, /2 folders, 3 groups, 4 contacts and 3 email messages/, 'summary wording');

    console.log('✓ Backup integrity checks passed:');
    console.log('  -', line);
    console.log('  - round-trip verification, missing-data detection and history merging all behave');
    console.log('  - drag & drop order and subfolder nesting survive the file and its hash');
} finally {
    await rm(outDir, { recursive: true, force: true });
}
