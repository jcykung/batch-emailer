// Proves the rich text layer the email composer depends on.
//
//   npm run verify-rich
//
// Gmail and Outlook only accept HTML through a paste, so everything that ends
// up on that clipboard (and in the communication log, which can also arrive
// from an imported file) passes through src/richText.js first. This checks:
//   1. sanitising keeps formatting, lists, links and tables
//   2. sanitising removes scripts, handlers, styles, classes and Word/Docs junk
//   3. unsafe URLs (javascript:, data:, obfuscated schemes) never survive
//   4. unbalanced markup comes back well-formed and sanitising is stable
//   5. the plain-text twin reads the way a mail client would fall back to
//   6. "is this rich?" only says yes for markup a compose link cannot express
//   7. a missing clipboard reports a failure instead of throwing
//   8. the composer builds correct Gmail/Outlook/mailto links, a safe
//      "DELETE BEFORE SENDING" header, and renders without throwing

import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToString } from 'react-dom/server';
import {
    sanitizeEmailHtml, htmlToPlainText, hasRichFormatting,
    escapeHtml, copyRichToClipboard
} from '../src/richText.js';

const checks = [];
const check = async (label, fn) => {
    try {
        await fn();
        checks.push(`  - ${label}`);
    } catch (error) {
        console.error(`✗ ${label}`);
        throw error;
    }
};

// --- 1. what must survive -----------------------------------------------------
await check('bold, italics, lists, links and headings survive', () => {
    const html = sanitizeEmailHtml(
        '<p>Hello <strong>parents</strong>, <em>quick</em> <u>update</u>.</p>' +
        '<ul><li>Item one</li><li>Item two</li></ul>' +
        '<ol start="3"><li>Third</li></ol><h3>Section</h3>' +
        '<p><a href="https://example.com/day?d=1&amp;w=2">Sign up</a></p>'
    );
    assert.match(html, /<strong>parents<\/strong>/);
    assert.match(html, /<em>quick<\/em>/);
    assert.match(html, /<u>update<\/u>/);
    assert.match(html, /<ul><li>Item one<\/li><li>Item two<\/li><\/ul>/);
    assert.match(html, /<ol start="3"><li>Third<\/li><\/ol>/);
    assert.match(html, /<h3>Section<\/h3>/);
    assert.match(html, /href="https:\/\/example\.com\/day\?d=1&amp;w=2"/);
    assert.match(html, /target="_blank"/);
});

await check('tables survive with the attributes Outlook needs', () => {
    const source = '<table border="1" cellpadding="6" cellspacing="0"><tbody>' +
        '<tr><th>Name</th><th>Score</th></tr>' +
        '<tr><td>Ada</td><td align="center" colspan="1">10</td></tr>' +
        '</tbody></table>';
    const html = sanitizeEmailHtml(source);
    assert.match(html, /<table border="1" cellpadding="6" cellspacing="0"/);
    assert.match(html, /border-collapse:collapse/);
    assert.match(html, /<th[^>]*bgcolor="#f6f8fa"/);
    assert.match(html, /<td[^>]*colspan="1"/);
    assert.match(html, /<\/tbody><\/table>/);
});

await check('a pasted table without attributes still gets borders', () => {
    const html = sanitizeEmailHtml('<table><tr><td>a</td><td>b</td></tr></table>');
    assert.match(html, /<table border="1" cellpadding="6" cellspacing="0"/);
    assert.match(html, /<td style="border:1px solid #d0d7de;/);
    assert.match(html, /<\/td><\/tr><\/table>/);
});

await check('cells with no table around them are wrapped in one', () => {
    const html = sanitizeEmailHtml('<td>orphan</td>');
    assert.match(html, /^<table[^>]*><tr><td[^>]*>orphan<\/td><\/tr><\/table>$/);
});

// --- 2. what must not ---------------------------------------------------------
await check('scripts and their contents are dropped', () => {
    const html = sanitizeEmailHtml('<p>hi</p><script>alert("x")<\/script><p>bye</p>');
    assert.equal(html, '<p>hi</p><p>bye</p>');
    assert.ok(!html.includes('alert'));
});

await check('event handlers, styles and classes are stripped', () => {
    const html = sanitizeEmailHtml(
        '<p onclick="steal()" class="MsoNormal" style="color:red;mso-fareast-font-family:Arial" id="x">text</p>'
    );
    assert.equal(html, '<p>text</p>');
});

await check('style blocks and Word/Docs wrappers never leak text', () => {
    const html = sanitizeEmailHtml(
        '<style>p{color:red}</style><o:p></o:p><span class="croso">Kept</span><body class="x">Text</body>'
    );
    assert.ok(!html.includes('color:red'));
    assert.ok(!html.includes('<span'));
    assert.match(html, /Kept/);
    assert.match(html, /Text/);
});

await check('unknown tags are removed but their text is kept', () => {
    assert.equal(sanitizeEmailHtml('<font color="red">Roses</font>'), 'Roses');
    assert.equal(sanitizeEmailHtml('<marquee>Fast</marquee>'), 'Fast');
});

await check('text cannot inject markup', () => {
    const html = sanitizeEmailHtml('1 < 2 and 3 > 2');
    assert.equal(html, '1 &lt; 2 and 3 &gt; 2');
});

// --- 3. URLs ------------------------------------------------------------------
await check('script and data URLs are rejected, real ones kept', () => {
    const bad = [
        '<a href="javascript:alert(1)">x</a>',
        '<a href="JaVaScRiPt:alert(1)">x</a>',
        '<a href="java\tscript:alert(1)">x</a>',
        '<a href="&#106;avascript:alert(1)">x</a>',
        '<a href="javascript&#58;alert(1)">x</a>',
        '<a href="  javascript:alert(1)">x</a>',
        '<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>',
        '<a href="vbscript:msgbox(1)">x</a>'
    ];
    for (const source of bad) {
        assert.equal(sanitizeEmailHtml(source), 'x', `expected rejection of ${source}`);
    }
});

await check('mailto, tel and in-page links are kept', () => {
    assert.match(sanitizeEmailHtml('<a href="mailto:a@b.com?subject=Hi">m</a>'), /href="mailto:a@b\.com\?subject=Hi"/);
    assert.match(sanitizeEmailHtml('<a href="tel:+15551234">t</a>'), /href="tel:\+15551234"/);
    assert.match(sanitizeEmailHtml('<a href="#top">t</a>'), /href="#top"/);
});

// --- 4. structure -------------------------------------------------------------
await check('unclosed tags are balanced', () => {
    const html = sanitizeEmailHtml('<p>one<strong>two<div>three');
    assert.equal(html, '<p>one<strong>two</strong></p><div>three</div>');
    assert.equal(sanitizeEmailHtml('<ul><li>a<li>b</ul>'), '<ul><li>a</li><li>b</li></ul>');
});

await check('sanitising is stable (running it twice changes nothing)', () => {
    const samples = [
        '<p>Hello <b>world</b></p>',
        '<table border="1"><tr><th>A</th></tr><tr><td style="x:y">B</td></tr></table>',
        '<div><p>nested</p></div><ul><li>one</li></ul>',
        '<a href="https://x.com" title="t">link</a>',
        '<p>1 &lt; 2 &amp; 3</p>'
    ];
    for (const sample of samples) {
        const once = sanitizeEmailHtml(sample);
        assert.equal(sanitizeEmailHtml(once), once, `not stable: ${sample}`);
    }
});

await check('malformed input cannot break out of the output', () => {
    const html = sanitizeEmailHtml('</p></td></tr><b>tail');
    assert.ok(!html.includes('</td>'));
    assert.match(html, /<b>tail<\/b>/);
});

// --- 5. plain text twin -------------------------------------------------------
await check('plain text reads like the message a client would fall back to', () => {
    const html = sanitizeEmailHtml(
        '<p>Line one</p><p>Line two</p><ul><li>Apples</li><li>Pears</li></ul>' +
        '<table><tr><th>Name</th><th>Score</th></tr><tr><td>Ada</td><td>10</td></tr></table>'
    );
    const text = htmlToPlainText(html);
    assert.match(text, /Line one\nLine two/);
    assert.match(text, /• Apples\n• Pears/);
    assert.match(text, /Name\tScore\nAda\t10/);
});

await check('entities decode and blank lines collapse', () => {
    assert.equal(htmlToPlainText('<p>Tom &amp; Jerry&#39;s&nbsp;show</p>'), "Tom & Jerry's\u00a0show");
    assert.equal(htmlToPlainText('<p>a</p><p></p><p></p><p>b</p>'), 'a\n\nb');
    assert.equal(htmlToPlainText(''), '');
    assert.equal(htmlToPlainText(null), '');
});

await check('tags that cannot appear in text leave nothing behind', () => {
    assert.equal(htmlToPlainText('<script>x()</script><p>kept</p><style>p{}</style>'), 'kept');
});

// --- 6. rich or plain ---------------------------------------------------------
await check('plain paragraphs are not treated as rich text', () => {
    assert.equal(hasRichFormatting(sanitizeEmailHtml('Hello parents,<br>see you Monday.')), false);
    assert.equal(hasRichFormatting(sanitizeEmailHtml('<div>one</div><div>two</div>')), false);
    assert.equal(hasRichFormatting(''), false);
});

await check('anything a compose link cannot express is rich text', () => {
    assert.equal(hasRichFormatting(sanitizeEmailHtml('<p><b>bold</b></p>')), true);
    assert.equal(hasRichFormatting(sanitizeEmailHtml('<ul><li>x</li></ul>')), true);
    assert.equal(hasRichFormatting(sanitizeEmailHtml('<table><tr><td>x</td></tr></table>')), true);
    assert.equal(hasRichFormatting(sanitizeEmailHtml('<p><a href="https://x.com">x</a></p>')), true);
});

// --- 7. clipboard -------------------------------------------------------------
await check('a missing clipboard reports a failure instead of throwing', async () => {
    const result = await copyRichToClipboard('<p>hello</p>', 'hello');
    assert.equal(result, 'failed');
});

// --- 8. the composer in src/App.jsx -------------------------------------------
const here = path.dirname(fileURLToPath(import.meta.url));
// Written inside the project so React resolves to the *same* copy that
// react-dom/server uses — bundling a second copy breaks hooks.
const appModule = path.join(here, '..', 'node_modules', '.verify-rich-app.mjs');
let app;

try {
    await build({
        entryPoints: [path.join(here, '..', 'src', 'App.jsx')],
        bundle: true,
        format: 'esm',
        platform: 'node',
        packages: 'external',
        outfile: appModule,
        logLevel: 'error'
    });

    // Browser globals touched while bundling/rendering.
    const memory = new Map();
    globalThis.localStorage = {
        getItem: (key) => (memory.has(key) ? memory.get(key) : null),
        setItem: (key, value) => memory.set(key, String(value)),
        removeItem: (key) => memory.delete(key)
    };
    globalThis.screen ??= { width: 0 };

    app = await import(pathToFileURL(appModule).href);
} finally {
    await rm(appModule, { force: true }).catch(() => {});
}

const batch = {
    bcc: 'ada@example.com,grace@example.com',
    subject: 'Class update & reminders',
    body: 'DELETE <me> & keep'
};

await check('plain messages keep the body in every compose link', () => {
    const urls = app.buildComposeUrls(batch, false);
    assert.equal(urls.gmail, 'https://mail.google.com/mail/?view=cm&fs=1'
        + '&bcc=ada%40example.com%2Cgrace%40example.com'
        + '&su=Class%20update%20%26%20reminders'
        + '&body=DELETE%20%3Cme%3E%20%26%20keep');
    assert.ok(urls.outlook.startsWith('https://outlook.office.com/mail/deeplink/compose?bcc='));
    assert.ok(urls.outlook.includes('&subject=Class%20update%20%26%20reminders'));
    assert.ok(urls.outlook.includes('&body='));
    assert.ok(urls.mailto.startsWith('mailto:?bcc='));
    assert.ok(urls.mailto.includes('&subject='));
    assert.ok(urls.mailto.includes('&body='));
});

await check('formatted messages drop body= instead of sending HTML literally', () => {
    const urls = app.buildComposeUrls(batch, true);
    for (const url of [urls.gmail, urls.outlook, urls.mailto]) {
        assert.ok(!url.includes('body='), `body should be omitted: ${url}`);
        assert.ok(url.includes('bcc=ada%40example.com'), `bcc should stay: ${url}`);
        assert.ok(url.includes('subject=') || url.includes('su='), `subject should stay: ${url}`);
    }
});

await check('the DELETE BEFORE SENDING header escapes contact names', () => {
    const header = app.buildDraftHeaderHtml('Ada <b>Lovelace</b>\nGrace & Co', '');
    assert.ok(header.startsWith('<div style="font-family:Arial'));
    assert.ok(header.endsWith('------------DELETE BEFORE SENDING------------</p>'));
    assert.ok(!header.includes('<b>Lovelace</b>'));
    assert.match(header, /Ada &lt;b&gt;Lovelace&lt;\/b&gt;/);
    assert.match(header, /Grace &amp; Co/);
    assert.equal((header.match(/DELETE BEFORE SENDING/g) || []).length, 2);

    const counted = app.buildDraftHeaderHtml('Ada', '\n(Email limits require batches: This is draft 1 of 2)');
    assert.match(counted, /This is draft 1 of 2/);
});

await check('inserted tables get the requested shape and a header row', () => {
    const withHeader = app.buildTableHtml(2, 3, true);
    assert.equal((withHeader.match(/<tr>/g) || []).length, 3);
    assert.equal((withHeader.match(/<th>/g) || []).length, 3);
    assert.equal((withHeader.match(/<td>/g) || []).length, 6);
    assert.match(withHeader, /border="1" cellpadding="6" cellspacing="0"/);

    const plainTable = app.buildTableHtml(1, 2, false);
    assert.equal((plainTable.match(/<th>/g) || []).length, 0);
    assert.equal((plainTable.match(/<tr>/g) || []).length, 1);
});

await check('the composer renders with its toolbar, editor and recipients', () => {
    const themeClasses = {
        textPrimary: 'text-[#fcfaf2]', cardBg: '', btnPrimary: '',
        btnSecondary: '', inputBg: '', textMuted: '', textSecondary: ''
    };
    const markup = renderToString(React.createElement(app.DraftEmailModal, {
        selectedStudents: [
            { id: 's1', name: 'Ada Lovelace', emails: ['ada@example.com'], emailHistory: [] },
            { id: 's2', name: 'Grace Hopper', emails: [], emailHistory: [] }
        ],
        closeModal: () => {},
        groupName: 'Class A',
        onLogMessage: () => {},
        themeClasses
    }));

    // React separates interpolated values with comment markers; drop them so
    // the assertions read like the text a person sees.
    const text = markup.replace(/<!--.*?-->/g, '');

    assert.match(text, /Draft Mass Email/);
    assert.match(text, /Recipients: 1 contacts/);
    assert.match(text, /1 selected contact\(s\) have no email addresses/);
    assert.match(text, /Message Content/);
    assert.match(text, /contenteditable="true"/);
    assert.match(text, /title="Bold \(Ctrl\+B\)"/);
    assert.match(text, /title="Bullet list"/);
    assert.match(text, /title="Insert table"/);
    assert.match(text, /title="Clear formatting"/);
    assert.ok(!text.includes('<textarea'), 'the plain textarea is gone');
});

// --- report -------------------------------------------------------------------
console.log('✓ Rich text checks passed:');
checks.forEach(line => console.log(line));
console.log('  - Gmail/Outlook paste path, log rendering and printed report stay safe');
console.log('  - composer toolbar, table builder and compose links behave');
