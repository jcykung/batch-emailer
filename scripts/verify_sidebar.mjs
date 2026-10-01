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

    // --- One pinned folder plus one plain folder --------------------------
    seed([
        { id: 'f1', name: 'Alpha', isArchived: false, isPinned: true, createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'f2', name: 'Beta', isArchived: false, isPinned: false, createdAt: '2026-01-02T00:00:00.000Z' }
    ], [
        { id: 'g1', folderId: 'f1', name: 'Period 1', isArchived: false, createdAt: '2026-01-03T00:00:00.000Z' }
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
    assert.match(pinnedHtml, /title="Period 1"/, "a pinned folder's groups stay visible");

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

    console.log('✓ Sidebar structure checks passed:');
    console.log('  - Pinned + Groups sections render; the New Folder button became a + beside Groups');
    console.log('  - pinned folders appear in both sections and the empty states read correctly');
} finally {
    rmSync(fileURLToPath(outfileUrl), { force: true });
}
