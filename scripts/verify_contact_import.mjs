// Proves the flexible contact importer: anything a person is likely to paste
// (Google Docs/Sheets tables, CSV, plain name/email lists) is read into
// name + emails + notes rows that the preview can then confirm.
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
    const { parseContactsFromText, buildContactRecords, parseCSV } = app;

    // --- 1. The original bug report: a Google Docs table copied as name line
    //        above email line ----------------------------------------------
    const docsStack = [
        'Samantha Sanuco',
        'samanthasanuco@gmail.com',
        'Ella St Pierre',
        'ellas111@deltalearns.ca',
        'Lacey Upjohn',
        'laceyu563@deltalearns.ca',
        'Karen Berar',
        'kberar@deltaschools.ca',
        'Beata Wiesnerova',
        'beataw002@deltalearns.ca',
        'Cherree Toth',
        'cherree.toth@gmail.com',
        'Gray Edgington',
        'gedgington5256@gmail.com',
        'Sarah Edgington',
        'sedgington5256@gmail.com',
        'Jonathan Kung',
        'jcykung@gmail.com',
        'Anneke Thomas',
        'annekemthomas@Outlook.com',
        'Samantha Cooley',
        'sjcooley22@gmail.com'
    ].join('\n');

    const stacked = parseContactsFromText(docsStack);
    assert.equal(stacked.length, 11, 'reads 11 contacts from a name/email stack');
    assert.equal(stacked[0].name, 'Samantha Sanuco');
    assert.deepEqual(stacked[0].emails, ['samanthasanuco@gmail.com']);
    assert.equal(stacked[3].name, 'Karen Berar');
    assert.deepEqual(stacked[3].emails, ['kberar@deltaschools.ca']);
    assert.equal(stacked[10].name, 'Samantha Cooley');
    assert.deepEqual(stacked[10].emails, ['sjcooley22@gmail.com']);
    assert.ok(stacked.every(r => r.name && r.emails.length === 1),
        'every stacked row pairs a name with its email');

    // --- 2. A real table: header row + tab separated cells + CRLF ----------
    const docsTable = 'Name\tEmail\tNotes\r\n'
        + 'Karen Berar\tkberar@deltaschools.ca\tMother: Karen\r\n'
        + 'Beata Wiesnerova\tbeataw002@deltalearns.ca\t\t\r\n';
    const table = parseContactsFromText(docsTable);
    assert.equal(table.length, 2, 'header row skipped, 2 contacts read');
    assert.equal(table[0].name, 'Karen Berar');
    assert.deepEqual(table[0].emails, ['kberar@deltaschools.ca']);
    assert.equal(table[0].notes, 'Mother: Karen');
    assert.equal(table[1].notes, '', 'empty note cells do not leak text');

    // --- 3. Comma separated rows, notes included ---------------------------
    const commas = parseContactsFromText(
        'Gray Edgington, gedgington5256@gmail.com, Father of Sarah\n'
        + 'Sarah Edgington, sedgington5256@gmail.com'
    );
    assert.equal(commas.length, 2);
    assert.equal(commas[0].name, 'Gray Edgington');
    assert.deepEqual(commas[0].emails, ['gedgington5256@gmail.com']);
    assert.equal(commas[0].notes, 'Father of Sarah');

    // --- 4. Names wrapped around the address ------------------------------
    const wrapped = parseContactsFromText(
        'Cherree Toth <cherree.toth@gmail.com>\n'
        + 'Jonathan Kung jcykung@gmail.com'
    );
    assert.equal(wrapped.length, 2);
    assert.equal(wrapped[0].name, 'Cherree Toth');
    assert.deepEqual(wrapped[0].emails, ['cherree.toth@gmail.com']);
    assert.equal(wrapped[1].name, 'Jonathan Kung');
    assert.deepEqual(wrapped[1].emails, ['jcykung@gmail.com']);

    // --- 5. Several emails under one name all attach to it -----------------
    const multi = parseContactsFromText(
        'Jonathan Kung\njcykung@gmail.com\njkung@example.ca\n\n\n'
        + 'Anneke Thomas\tannekemthomas@Outlook.com, other@example.com'
    );
    assert.equal(multi.length, 2, 'blank lines ignored');
    assert.deepEqual(multi[0].emails, ['jcykung@gmail.com', 'jkung@example.ca'],
        'stacked email lines join the name above them');
    assert.deepEqual(multi[1].emails, ['annekemthomas@Outlook.com', 'other@example.com'],
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
    const csvRow = parseCSV('"Doe, Jane",jane@example.com,"Mother: Jane, teacher"');
    assert.deepEqual(csvRow, [['Doe, Jane', 'jane@example.com', 'Mother: Jane, teacher']]);
    const csv = buildContactRecords(csvRow);
    assert.equal(csv.length, 1);
    assert.equal(csv[0].name, 'Doe, Jane');
    assert.deepEqual(csv[0].emails, ['jane@example.com']);
    assert.equal(csv[0].notes, 'Mother: Jane, teacher');

    // The same text pasted into the paste box reads identically.
    const pastedCsv = parseContactsFromText(
        'Name,Email,Notes\n"Doe, Jane",jane@example.com,"Mother: Jane, teacher"\n'
    );
    assert.equal(pastedCsv.length, 1, 'quoted CSV pasted as text keeps one row');
    assert.equal(pastedCsv[0].name, 'Doe, Jane');
    assert.deepEqual(pastedCsv[0].emails, ['jane@example.com']);
    assert.equal(pastedCsv[0].notes, 'Mother: Jane, teacher');

    // --- 9. Duplicate addresses inside a row are collapsed -----------------
    const deduped = parseContactsFromText('A Person\ta@b.com, a@b.com, c@d.com');
    assert.deepEqual(deduped[0].emails, ['a@b.com', 'c@d.com']);

    console.log('✓ Contact import checks passed:');
    console.log('  - name/email stacks, tables, CSV, wrapped addresses, headers and dedupe all behave');
} finally {
    await rm(outDir, { recursive: true, force: true });
}
