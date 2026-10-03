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
//   7. a sync conflict can be MERGED without losing a message from either side
//   8. the conflict dialog is told how many messages each side holds
//   9. the pull guard spots a file that lost messages this device still has
//  10. the automatic backup history spreads over time instead of the last edits

import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The rolling in-browser backup history lives in syncStorage.js (plain ESM, no
// JSX), so it is imported directly rather than bundled with the app helpers.
const { AUTO_BACKUP_MAX_RECORDS, selectAutoBackupsToKeep } = await import(
    pathToFileURL(path.join(root, 'src', 'syncStorage.js')).href
);

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
        mergeSyncData, countMessagesMissingFromFile, getCanonicalData,
        generateDataFingerprint, compareFingerprints
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
                emails: ['alice@example.com', 'backup@example.com'],
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

    // --- 7. A sync conflict can be resolved without losing either side ------
    // Both computers changed before they met: the file holds messages logged
    // there, local holds messages logged here, one contact overlaps (so the
    // same message appears on both sides) and each side has a contact the
    // other never saw. "Keep one side" would throw half of this away — the
    // merge resolution must keep all of it.
    const localSide = {
        folders: [{ id: 'f1', name: 'North Region', isArchived: false, parentId: null, createdAt: '2026-01-01T00:00:00.000Z' }],
        classes: [{ id: 'g1', folderId: 'f1', name: 'Newsletter', isArchived: false, createdAt: '2026-01-03T00:00:00.000Z' }],
        students: [
            {
                id: 's1', classId: 'g1', name: 'Alice Adams', emails: ['alice@example.com'], notes: '',
                emailHistory: [
                    { id: 'h1', timestamp: '2026-09-01T09:00:00.000Z', subject: 'Welcome back', message: 'From this computer' }
                ]
            },
            {
                id: 's2', classId: 'g1', name: 'Bob Barnes', emails: ['bob@example.com'], notes: '',
                emailHistory: [
                    { id: 'h9', timestamp: '2026-09-30T09:00:00.000Z', subject: 'Only here', message: 'Local-only message' }
                ]
            }
        ]
    };
    const fileSide = {
        folders: [
            { id: 'f1', name: 'North Region', isArchived: false, parentId: null, createdAt: '2026-01-01T00:00:00.000Z' },
            { id: 'f2', name: 'Events', isArchived: false, parentId: null, createdAt: '2026-01-02T00:00:00.000Z' }
        ],
        classes: [
            { id: 'g1', folderId: 'f1', name: 'Newsletter', isArchived: false, createdAt: '2026-01-03T00:00:00.000Z' },
            { id: 'g2', folderId: 'f2', name: 'Sponsors', isArchived: false, createdAt: '2026-01-04T00:00:00.000Z' }
        ],
        students: [
            {
                id: 's1', classId: 'g1', name: 'Alice Adams', emails: ['alice@example.com'], notes: '',
                emailHistory: [
                    { id: 'h1', timestamp: '2026-09-01T09:00:00.000Z', subject: 'Welcome back', message: 'From this computer' },
                    { id: 'h2', timestamp: '2026-09-20T10:00:00.000Z', subject: 'Trip reminder', message: 'From the other computer' }
                ]
            },
            {
                id: 's3', classId: 'g2', name: 'Carol Chen', emails: ['carol@example.com'], notes: '',
                emailHistory: [
                    { id: 'h3', timestamp: '2026-09-21T11:00:00.000Z', subject: 'Sponsor update', message: 'File-only message' }
                ]
            }
        ]
    };

    assert.equal(countEmailMessages(localSide), 2, 'fixture: local side holds 2 messages');
    assert.equal(countEmailMessages(fileSide), 3, 'fixture: file side holds 3 messages');

    const mergedSides = mergeSyncData(localSide, fileSide);
    assert.equal(countEmailMessages(mergedSides), 4,
        'merging keeps every message: only the one duplicated log collapses');
    assert.equal(mergedSides.students.length, 3, 'a contact that exists on both sides is not duplicated');

    const mergedAlice = mergedSides.students.find(s => s.id === 's1');
    assert.equal(mergedAlice.emailHistory.length, 2, 'the shared contact absorbed the other computer\'s message');
    assert.ok(mergedAlice.emailHistory.some(l => l.id === 'h2'),
        'the message logged on the other computer is in the merged history');
    assert.ok(mergedSides.students.some(s => s.id === 's2'), 'the contact only this computer has is kept');
    assert.ok(mergedSides.students.some(s => s.id === 's3'), 'the contact only the file has is kept');
    assert.deepEqual(mergedSides.folders.map(f => f.id), ['f1', 'f2'],
        'folders are unioned, local order first');
    assert.deepEqual(mergedSides.classes.map(c => c.id), ['g1', 'g2'], 'groups are unioned too');
    assert.equal(mergedSides.classes.find(c => c.id === 'g2').folderId, 'f2',
        'a group whose folder only existed in the file still points at a folder that survived the merge');

    // What gets pushed after a merge is a normal, fully verified file.
    const mergedPayload = await buildBackupPayload(mergedSides, 11);
    await verifyBackupRoundTrip(await encryptExport(mergedPayload), mergedSides, mergedPayload.settings);

    // --- 8. The conflict dialog can say how many messages each side holds ----
    // "Keep one side" is a blind choice unless the user can see that one side
    // has more messages than the other before clicking it.
    const localFP = generateDataFingerprint(localSide);
    const fileFP = generateDataFingerprint(fileSide);
    assert.equal(localFP.messageCount, 2, 'fingerprint carries the local message count');
    assert.equal(fileFP.messageCount, 3, 'fingerprint carries the file message count');
    const conflictDiff = compareFingerprints(localFP, fileFP);
    const messageDiff = (conflictDiff.differences || []).find(d => d.type === 'messageCount');
    assert.ok(messageDiff, 'the comparison names the message-count difference');
    assert.match(messageDiff.description, /2 local vs 3 in file/,
        'the difference spells out how many messages each side holds');

    // --- 9. The pull guard notices a file that lost messages ----------------
    // A clean pull is only safe while the file is a superset of what this
    // device last synced. If the same contact still has messages here that the
    // file no longer holds, pulling would drop them — so the decision engine
    // has to be able to see it and divert to the conflict dialog instead.
    const localAhead = {
        students: [
            {
                id: 's1',
                emailHistory: [
                    { id: 'h1', timestamp: '2026-09-01T09:00:00.000Z', message: 'both sides have this' },
                    { id: 'h4', timestamp: '2026-09-25T09:00:00.000Z', message: 'only this device has this' }
                ]
            },
            { id: 's9', emailHistory: [{ id: 'h9', timestamp: '2026-09-26T09:00:00.000Z', message: 'contact the file deleted' }] }
        ]
    };
    const fileBehind = { students: [{ id: 's1', emailHistory: [{ id: 'h1', timestamp: '2026-09-01T09:00:00.000Z', message: 'both sides have this' }] }] };

    assert.equal(countMessagesMissingFromFile(localAhead, fileBehind), 1,
        'the file lost one message this device still has');
    assert.equal(countMessagesMissingFromFile(fileBehind, localAhead), 0,
        'the file is not missing anything from the other direction');
    assert.equal(countMessagesMissingFromFile(localAhead, localAhead), 0,
        'a file that still has everything reports 0, so ordinary pulls are untouched');
    assert.equal(countMessagesMissingFromFile(localAhead, { students: [] }), 0,
        'a contact the file does not have at all is a deletion, not lost history');

    const legacyLocal = { students: [{ id: 's1', emailHistory: [{ timestamp: '2026-01-01T00:00:00.000Z', message: 'legacy body' }] }] };
    assert.equal(countMessagesMissingFromFile(legacyLocal, legacyLocal), 0,
        'log entries without an id are matched on timestamp + message');
    assert.equal(countMessagesMissingFromFile(legacyLocal, { students: [{ id: 's1', emailHistory: [] }] }), 1,
        '...and are still detected when the file drops them');

    // --- 10. Automatic backups cover time, not just the last few edits ------
    // A rolling history capped at N records is only a safety net if those N
    // slots are spread out: "the last 12 saves" is usually the last 12 edits,
    // which covers about a minute of work.
    const now = Date.parse('2026-10-02T12:00:00.000Z');
    const perMinute = Array.from({ length: 4200 }, (_, i) => ({
        id: `m${i}`,
        timestamp: new Date(now - i * 60000).toISOString()
    }));
    const keptMinutes = selectAutoBackupsToKeep(perMinute, AUTO_BACKUP_MAX_RECORDS);

    assert.ok(keptMinutes.length <= AUTO_BACKUP_MAX_RECORDS, 'pruning never exceeds the cap');
    assert.equal(keptMinutes[0].id, 'm0', 'the newest snapshot always survives');
    const minuteSpan = (now - Date.parse(keptMinutes[keptMinutes.length - 1].timestamp)) / 86400000;
    assert.ok(minuteSpan >= 1,
        `a dense history keeps coverage (${minuteSpan.toFixed(1)} days) instead of the last ${AUTO_BACKUP_MAX_RECORDS} edits`);

    // Gaps must be contiguous: each kept snapshot is strictly older than the
    // one before it, and consecutive keeps widen rather than crowd.
    for (let i = 1; i < keptMinutes.length; i++) {
        const previous = Date.parse(keptMinutes[i - 1].timestamp);
        const current = Date.parse(keptMinutes[i].timestamp);
        assert.ok(current < previous, 'snapshots stay in newest-first order');
        assert.ok(previous - current >= 60000, 'no two kept snapshots are closer than a minute');
    }

    const perDay = Array.from({ length: 40 }, (_, i) => ({
        id: `d${i}`,
        timestamp: new Date(now - i * 86400000).toISOString()
    }));
    const keptDays = selectAutoBackupsToKeep(perDay, AUTO_BACKUP_MAX_RECORDS);
    assert.equal(keptDays.length, AUTO_BACKUP_MAX_RECORDS, 'a long, sparse history fills every slot');
    assert.ok((now - Date.parse(keptDays[keptDays.length - 1].timestamp)) / 86400000 >= 10,
        'and reaches back at least 10 days');

    // Saves made seconds apart are the same moment as far as a history is
    // concerned — they must not consume slots.
    const burst = ['m0', 'm1', 'm2'].map(id => ({
        id,
        timestamp: new Date(now - Number(id.slice(1)) * 60000).toISOString()
    }));
    assert.equal(selectAutoBackupsToKeep(burst, AUTO_BACKUP_MAX_RECORDS).length, 1,
        'three saves in three minutes become one snapshot');

    // --- Human readable summary ---------------------------------------------
    const line = describeDataSummary(dataset);
    assert.match(line, /2 folders, 3 groups, 4 contacts and 3 email messages/, 'summary wording');

    console.log('✓ Backup integrity checks passed:');
    console.log('  -', line);
    console.log('  - round-trip verification, missing-data detection and history merging all behave');
    console.log('  - a sync conflict can be merged without dropping a message from either side');
    console.log('  - a sync file that lost messages is caught instead of pulled over the top');
    console.log('  - the automatic backup history spreads its slots over time, not over the last edits');
    console.log('  - drag & drop order and subfolder nesting survive the file and its hash');
} finally {
    await rm(outDir, { recursive: true, force: true });
}
