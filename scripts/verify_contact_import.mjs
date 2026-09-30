// Proves the flexible contact importer: anything a person is likely to paste
// (Google Docs/Sheets tables, CSV, plain name/email lists) is read into
// name + emails + notes rows that the preview can then confirm.
//
// Every fixture below is invented: RFC 2606 reserves example.com/.org/.net so
// no real person's name or address is stored in this repo.
//
//   npm run verify-import

import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const outDir = await mkdtemp(path.join(tmpdir(), 'batch-emailer-import-'));
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

    const memory = new Map();
    globalThis.localStorage = {
        getItem: (key) => (memory.has(key) ? memory.get(key) : null),
        setItem: (key, value) => memory.set(key, String(value)),
        removeItem: (key) => memory.delete(key)
    };
    globalThis.screen ??= { width: 0 };

    const app = await import(pathToFileURL(outFile).href);
    const {
        parseContactsFromText, buildContactRecords, parseCSV,
        IMPORT_EXAMPLE_PASTE, IMPORT_EXAMPLE_CSV
    } = app;

    // --- 1. The original bug report: a Google Docs table copied as name line
    //        above email line ----------------------------------------------
    const docsStack = [
        'Jamie Rivera',
        'jamie.rivera@example.com',
        'Priya Nair',
        'priya.nair@example.com',
        'Sam Lee',
        'sam.lee@example.org',
        'Alex Rivera',
        'a.rivera@example.com',
        'Dana Kim',
        'dana.kim@example.org',
        'Chris Vogel',
        'chris.vogel@example.net',
        'Morgan Bell',
        'morgan.bell@example.com',
        'Taylor Osei',
        'taylor.osei@example.org',
        'Jordan Fox',
        'jordan.fox@example.net',
        'Casey Lin',
        'casey.lin@example.com',
        'Robin Diaz',
        'robin.diaz@example.org'
    ].join('\n');

    const stacked = parseContactsFromText(docsStack);
    assert.equal(stacked.length, 11, 'reads 11 contacts from a name/email stack');
    assert.equal(stacked[0].name, 'Jamie Rivera');
    assert.deepEqual(stacked[0].emails, ['jamie.rivera@example.com']);
    assert.equal(stacked[3].name, 'Alex Rivera');
    assert.deepEqual(stacked[3].emails, ['a.rivera@example.com']);
    assert.equal(stacked[10].name, 'Robin Diaz');
    assert.deepEqual(stacked[10].emails, ['robin.diaz@example.org']);
    assert.ok(stacked.every(r => r.name && r.emails.length === 1),
        'every stacked row pairs a name with its email');

    // --- 2. A table: header row + tab separated cells + CRLF ---------------
    const docsTable = 'Name\tEmail\tNotes\r\n'
        + 'Dana Kim\tdana.kim@example.org\tEmergency contact\r\n'
        + 'Chris Vogel\tchris.vogel@example.net\t\t\r\n';
    const table = parseContactsFromText(docsTable);
    assert.equal(table.length, 2, 'header row skipped, 2 contacts read');
    assert.equal(table[0].name, 'Dana Kim');
    assert.deepEqual(table[0].emails, ['dana.kim@example.org']);
    assert.equal(table[0].notes, 'Emergency contact');
    assert.equal(table[1].notes, '', 'empty note cells do not leak text');

    // --- 3. Comma separated rows, notes included ---------------------------
    const commas = parseContactsFromText(
        'Morgan Bell, morgan.bell@example.com, Class rep\n'
        + 'Taylor Osei, taylor.osei@example.org'
    );
    assert.equal(commas.length, 2);
    assert.equal(commas[0].name, 'Morgan Bell');
    assert.deepEqual(commas[0].emails, ['morgan.bell@example.com']);
    assert.equal(commas[0].notes, 'Class rep');

    // --- 4. Names wrapped around the address ------------------------------
    const wrapped = parseContactsFromText(
        'Casey Lin <casey.lin@example.com>\n'
        + 'Jordan Fox jordan.fox@example.net'
    );
    assert.equal(wrapped.length, 2);
    assert.equal(wrapped[0].name, 'Casey Lin');
    assert.deepEqual(wrapped[0].emails, ['casey.lin@example.com']);
    assert.equal(wrapped[1].name, 'Jordan Fox');
    assert.deepEqual(wrapped[1].emails, ['jordan.fox@example.net']);

    // --- 5. Several emails under one name all attach to it -----------------
    const multi = parseContactsFromText(
        'Robin Diaz\nrobin.diaz@example.com\nr.diaz@example.net\n\n\n'
        + 'Jamie Rivera\tjamie.rivera@example.com, j.rivera@example.org'
    );
    assert.equal(multi.length, 2, 'blank lines ignored');
    assert.deepEqual(multi[0].emails, ['robin.diaz@example.com', 'r.diaz@example.net'],
        'stacked email lines join the name above them');
    assert.deepEqual(multi[1].emails, ['jamie.rivera@example.com', 'j.rivera@example.org'],
        'several emails in one row are all kept');

    // --- 6. Header-only input imports nothing -----------------------------
    assert.deepEqual(parseContactsFromText('Name,Email,Notes'), [], 'header row only');
    assert.deepEqual(parseContactsFromText('   \n\n\t  '), [], 'blank input');

    // --- 7. Orphan emails are kept (as a nameless row the preview can fix) -
    const orphan = parseContactsFromText('lone@example.com');
    assert.equal(orphan.length, 1);
    assert.equal(orphan[0].name, '');
    assert.deepEqual(orphan[0].emails, ['lone@example.com']);

    // --- 8. Real CSV with quoted commas ------------------------------------
    const csvRow = parseCSV('"Doe, Jane",jane@example.com,"Sister: Jo, teacher"');
    assert.deepEqual(csvRow, [['Doe, Jane', 'jane@example.com', 'Sister: Jo, teacher']]);
    const csv = buildContactRecords(csvRow);
    assert.equal(csv.length, 1);
    assert.equal(csv[0].name, 'Doe, Jane');
    assert.deepEqual(csv[0].emails, ['jane@example.com']);
    assert.equal(csv[0].notes, 'Sister: Jo, teacher');

    // The same text pasted into the paste box reads identically.
    const pastedCsv = parseContactsFromText(
        'Name,Email,Notes\n"Doe, Jane",jane@example.com,"Sister: Jo, teacher"\n'
    );
    assert.equal(pastedCsv.length, 1, 'quoted CSV pasted as text keeps one row');
    assert.equal(pastedCsv[0].name, 'Doe, Jane');
    assert.deepEqual(pastedCsv[0].emails, ['jane@example.com']);
    assert.equal(pastedCsv[0].notes, 'Sister: Jo, teacher');

    // --- 9. Duplicate addresses inside a row are collapsed -----------------
    const deduped = parseContactsFromText('Alex Rivera\talex@example.com, alex@example.com, alias@example.org');
    assert.deepEqual(deduped[0].emails, ['alex@example.com', 'alias@example.org']);

    // --- 10. The examples printed inside the Import Contacts dialog read
    //         exactly the way their captions promise ------------------------
    const pasteExample = parseContactsFromText(IMPORT_EXAMPLE_PASTE);
    assert.equal(pasteExample.length, 3, 'paste example: header skipped, 3 contacts');
    assert.equal(pasteExample[0].name, 'Jamie Rivera');
    assert.deepEqual(pasteExample[0].emails,
        ['jamie.rivera@example.com', 'parent@example.org'],
        'paste example: the tab row keeps both emails');
    assert.equal(pasteExample[0].notes, 'Sibling: Alex Rivera');
    assert.equal(pasteExample[1].name, 'Priya Nair');
    assert.deepEqual(pasteExample[1].emails, ['priya.nair@example.com']);
    assert.equal(pasteExample[1].notes, 'Class rep');
    assert.equal(pasteExample[2].name, 'Sam Lee');
    assert.deepEqual(pasteExample[2].emails,
        ['sam.lee@example.com', 'parent@example.com'],
        'paste example: both stacked lines belong to Sam Lee');

    const csvExample = buildContactRecords(parseCSV(IMPORT_EXAMPLE_CSV));
    assert.equal(csvExample.length, 3, 'CSV example: header skipped, 3 contacts');
    assert.equal(csvExample[0].name, 'Jamie Rivera');
    assert.deepEqual(csvExample[0].emails,
        ['jamie.rivera@example.com', 'parent@example.org']);
    assert.equal(csvExample[0].notes, 'Sibling: Alex Rivera');
    assert.equal(csvExample[1].name, 'Priya Nair');
    assert.deepEqual(csvExample[1].emails, ['priya.nair@example.com'],
        'CSV example: an empty Email 2 cell is fine');
    assert.equal(csvExample[1].notes, 'Class rep');
    assert.equal(csvExample[2].name, 'Sam Lee');
    assert.deepEqual(csvExample[2].emails,
        ['sam.lee@example.com', 'parent@example.com']);
    assert.equal(csvExample[2].notes, 'New neighbour');

    console.log('✓ Contact import checks passed:');
    console.log('  - name/email stacks, tables, CSV, wrapped addresses, headers and dedupe all behave');
    console.log('  - the fake-data examples shown in the Import Contacts dialog parse as documented');
} finally {
    await rm(outDir, { recursive: true, force: true });
}
