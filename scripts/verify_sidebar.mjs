// Sidebar structure checks: renders <App /> with react-dom/server and proves
// that the sidebar keeps its two collapsible sections (Pinned, Groups), that
// the old "New Folder" button is gone in favour of the "+" beside Groups, and
// that pinned folders show up in both sections while the empty states behave.
import { build } from 'esbuild';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';

const store = new Map();
const fakeStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    clear: () => { store.clear(); }
};

// The app touches a handful of browser globals while rendering; stub the ones
// React's server renderer actually walks past (effects never run in SSR).
globalThis.window = {
    localStorage: fakeStorage,
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
    innerWidth: 1400,
    innerHeight: 900
};
globalThis.localStorage = fakeStorage;
globalThis.document = {
    addEventListener() {},
    removeEventListener() {},
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
    body: { appendChild() {}, removeChild() {} }
};
if (!globalThis.crypto?.randomUUID) {
    globalThis.crypto = { ...globalThis.crypto, randomUUID: () => 'id-' + Math.random().toString(16).slice(2) };
}

const outfileUrl = new URL('../node_modules/.verify-sidebar-app.mjs', import.meta.url);

// Bundle App.jsx rather than importing it directly so React comes from
// node_modules exactly once (a second copy would break renderToString).
await build({
    entryPoints: ['src/App.jsx'],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    jsx: 'automatic',
    packages: 'external',
    outfile: fileURLToPath(outfileUrl)
});

try {
    const { renderToString } = await import('react-dom/server');
    const React = (await import('react')).default;
    const { default: App } = await import(outfileUrl.href);

    const seed = (folders, classes = []) => {
        store.set('batch-emailer-data', JSON.stringify({ folders, classes, students: [] }));
    };
    const count = (hay, needle) => hay.split(needle).length - 1;

    // --- Pinned folder + pinned group, plus plain ones ---------------------
    seed([
        { id: 'f1', name: 'Alpha', isArchived: false, isPinned: true, createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'f2', name: 'Beta', isArchived: false, isPinned: false, createdAt: '2026-01-02T00:00:00.000Z' }
    ], [
        { id: 'g1', folderId: 'f1', name: 'Period 1', isArchived: false, isPinned: true, createdAt: '2026-01-03T00:00:00.000Z' },
        { id: 'g2', folderId: 'f2', name: 'Chess', isArchived: false, isPinned: false, createdAt: '2026-01-04T00:00:00.000Z' }
    ]);

    const pinnedHtml = renderToString(React.createElement(App));
    assert.match(pinnedHtml, /Pinned/, 'Pinned section header renders');
    assert.match(pinnedHtml, /Groups/, 'Groups section header renders');
    assert.ok(!/>New Folder</.test(pinnedHtml), 'standalone New Folder button is gone');
    assert.match(pinnedHtml, /aria-label="New Folder"/, '+ button beside Groups adds a folder');
    assert.strictEqual(count(pinnedHtml, 'title="Alpha"'), 2, 'pinned folder shows in Pinned and in Groups');
    assert.strictEqual(count(pinnedHtml, 'title="Beta"'), 1, 'unpinned folder shows only in Groups');
    assert.match(pinnedHtml, /title="Unpin folder"/, 'hover pin toggle renders for the pinned folder');
    assert.match(pinnedHtml, /title="Pin folder"/, 'hover pin toggle renders for the unpinned folder');
    assert.strictEqual(
        count(pinnedHtml, 'title="Period 1"'),
        3,
        'pinned group appears on its own plus inside its folder wherever that folder is listed'
    );
    assert.strictEqual(count(pinnedHtml, 'title="Chess"'), 1, 'unpinned group shows only inside its folder');
    assert.match(pinnedHtml, /title="Unpin group"/, 'hover pin toggle renders for the pinned group');
    assert.match(pinnedHtml, /title="Pin group"/, 'hover pin toggle renders for the unpinned group');
    assert.match(pinnedHtml, /title="In folder: Alpha"/, 'a pinned group names the folder it lives in');
    assert.strictEqual(
        count(pinnedHtml, 'aria-label="Pinned"'),
        5,
        'pin badges render for both pinned items in every place they are listed'
    );
    assert.match(pinnedHtml, /aria-label="Close sidebar"/, 'divider handle renders as an arrow toggle');
    assert.match(pinnedHtml, /lucide-chevron-left/, 'the arrow points at the sidebar while it is open');
    assert.ok(!/Toggle Sidebar/.test(pinnedHtml), 'the old hamburger toggle is gone from the header');

    // --- Nothing pinned ---------------------------------------------------
    seed([
        { id: 'f2', name: 'Beta', isArchived: false, isPinned: false, createdAt: '2026-01-02T00:00:00.000Z' }
    ]);
    const emptyPinHtml = renderToString(React.createElement(App));
    assert.match(emptyPinHtml, /Nothing pinned yet/, 'Pinned placeholder shows when nothing is pinned');
    assert.strictEqual(count(emptyPinHtml, 'title="Beta"'), 1, 'unpinned folder is listed once (Groups only)');

    // --- No folders at all ------------------------------------------------
    seed([]);
    const noFoldersHtml = renderToString(React.createElement(App));
    assert.match(noFoldersHtml, /Nothing pinned yet/, 'Pinned placeholder with no folders');
    assert.match(noFoldersHtml, /Press \+ to create one/, 'Groups empty state points at the + button');
    assert.match(noFoldersHtml, /Right-click a folder or group/, 'placeholder explains how to pin both kinds');

    // --- Order is part of the data (drag & drop reordering) ----------------
    const { getCanonicalData } = await import(outfileUrl.href);
    const orderSeed = [
        { id: 'f1', name: 'A', isArchived: false, isPinned: false, createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'f2', name: 'B', isArchived: false, isPinned: false, createdAt: '2026-01-02T00:00:00.000Z' }
    ];
    const asGiven = JSON.stringify(getCanonicalData({ folders: orderSeed, classes: [], students: [] }));
    const asReordered = JSON.stringify(getCanonicalData({ folders: [...orderSeed].reverse(), classes: [], students: [] }));
    assert.notStrictEqual(asGiven, asReordered, 'reordering folders changes the canonical data (so sync sees it)');
    const groupsAsGiven = JSON.stringify(getCanonicalData({ folders: [], classes: [
        { id: 'g1', folderId: 'f1', name: 'One' },
        { id: 'g2', folderId: 'f1', name: 'Two' }
    ], students: [] }));
    const groupsReordered = JSON.stringify(getCanonicalData({ folders: [], classes: [
        { id: 'g2', folderId: 'f1', name: 'Two' },
        { id: 'g1', folderId: 'f1', name: 'One' }
    ], students: [] }));
    assert.notStrictEqual(groupsAsGiven, groupsReordered, 'reordering groups changes the canonical data too');
    const sortedStudents = getCanonicalData({ folders: [], classes: [], students: [
        { id: 's2', name: 'B', emails: [], emailHistory: [] },
        { id: 's1', name: 'A', emails: [], emailHistory: [] }
    ] }).students.map(s => s.id).join(',');
    assert.strictEqual(sortedStudents, 's1,s2', 'contacts stay id-sorted: they have no user order');

    // --- Drag & drop ordering math ----------------------------------------
    const { moveItemInList, moveGroupToFolder, moveGroupBesideGroup } = await import(outfileUrl.href);
    const ids = list => list.map(i => i.id).join(',');
    const folderList = [{ id: 'f1' }, { id: 'f2' }, { id: 'f3' }];
    assert.strictEqual(ids(moveItemInList(folderList, 'f3', 'f1', true)), 'f1,f3,f2', 'folder dropped after another lands beside it');
    assert.strictEqual(ids(moveItemInList(folderList, 'f1', 'f3', false)), 'f2,f1,f3', 'folder dropped before another moves up');
    assert.strictEqual(ids(moveItemInList(folderList, 'f2', 'f2', true)), 'f1,f2,f3', 'dropping a folder on itself changes nothing');
    assert.strictEqual(ids(folderList), 'f1,f2,f3', 'the folder list itself is never mutated');

    const groupList = [
        { id: 'g1', folderId: 'f1' },
        { id: 'g2', folderId: 'f1' },
        { id: 'g3', folderId: 'f2' }
    ];
    assert.strictEqual(ids(moveGroupToFolder(groupList, 'g3', 'f1', false)), 'g3,g1,g2', 'group dropped on a folder joins at its top');
    assert.strictEqual(ids(moveGroupToFolder(groupList, 'g1', 'f2', true)), 'g2,g3,g1', 'group dropped after a folder joins at its bottom');
    assert.strictEqual(moveGroupToFolder(groupList, 'g1', 'f2', false)[1].folderId, 'f2', 'moving into a folder rewrites its folderId');
    assert.strictEqual(ids(moveGroupBesideGroup(groupList, 'g1', 'g2', true)), 'g2,g1,g3', 'group dropped next to a group lands beside it');
    assert.strictEqual(moveGroupBesideGroup(groupList, 'g3', 'g2', false)[1].folderId, 'f1', 'a group dropped on a group joins that folder');
    assert.strictEqual(ids(groupList), 'g1,g2,g3', 'the group list itself is never mutated');

    // --- Order-only sync differences are explained -------------------------
    const { generateDataFingerprint, compareFingerprints } = await import(outfileUrl.href);
    const orderA = { folders: orderSeed, classes: [{ id: 'g1', folderId: 'f1', name: 'One' }], students: [] };
    const orderB = { folders: [...orderSeed].reverse(), classes: [{ id: 'g1', folderId: 'f1', name: 'One' }], students: [] };
    const orderDiff = compareFingerprints(generateDataFingerprint(orderA), generateDataFingerprint(orderB));
    assert.ok(orderDiff.hasDifferences, 'a reorder alone is reported as a difference');
    assert.ok(
        orderDiff.differences.some(d => d.type === 'folderOrder'),
        'the conflict dialog can say the folder order differs'
    );
    const sameOrder = compareFingerprints(
        generateDataFingerprint(orderA),
        generateDataFingerprint({ ...orderA, timestamp: 0 })
    );
    assert.strictEqual(sameOrder.hasDifferences, false, 'identical data still reports no differences');

    // --- Drag & drop wiring ------------------------------------------------
    assert.strictEqual(
        count(pinnedHtml, 'draggable="true"'),
        7,
        'every folder/group row is draggable: 3 in Pinned (folder, its group, the pinned group) + 4 in Groups'
    );
    assert.strictEqual(count(pinnedHtml, 'draggable="false"'), 0, 'no row is excluded from dragging');

    console.log('✓ Sidebar structure checks passed:');
    console.log('  - Pinned + Groups sections render; the New Folder button became a + beside Groups');
    console.log('  - pinned folders and groups each appear in Pinned and in their place in the tree');
    console.log('  - divider arrow replaces the hamburger and the empty states read correctly');
} finally {
    rmSync(fileURLToPath(outfileUrl), { force: true });
}
