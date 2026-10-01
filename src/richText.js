// --- Rich text for the email composer -----------------------------------------
//
// Gmail and Outlook both refuse HTML through their compose links: the `body=`
// parameter of mail.google.com/mail/?view=cm and outlook.office.com/mail/
// deeplink/compose is plain text, and so is `mailto:`. Formatted mail
// therefore has to travel the way a person moves it — as `text/html` on the
// clipboard, pasted into the compose window — which is what the composer in
// App.jsx does. This module holds everything that has to be trustworthy on
// that path:
//
//   sanitizeEmailHtml()    whitelist-only HTML. Applied before anything is
//                          stored, before it is copied and again before it is
//                          rendered, because a log entry can also arrive from
//                          an imported or synced file.
//   htmlToPlainText()      the plain-text twin of every message, used for the
//                          compose links, the clipboard fallback and the log.
//   hasRichFormatting()    decides whether a message needs the paste flow at
//                          all, so plain messages keep working exactly as
//                          before.
//   copyRichToClipboard()  puts text/html on the clipboard, with fallbacks for
//                          browsers that block the async clipboard API.
//   escapeHtml()           for the printed report, which builds HTML by hand.
//
// Deliberately free of DOM dependencies: the verify script runs all of this
// under plain Node, so every function here works on strings alone.

const ALLOWED_TAGS = new Set([
    'p', 'div', 'br', 'hr',
    'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'del', 'sub', 'sup',
    'a', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption'
]);

// Tags whose contents are code or chrome rather than message text: everything
// between the opening and closing tag is dropped, not just the tags.
const DROP_WITH_CONTENT = new Set([
    'script', 'style', 'head', 'title', 'noscript', 'template',
    'iframe', 'object', 'embed', 'svg', 'math', 'canvas', 'video', 'audio',
    'base', 'link', 'meta', 'applet', 'frame', 'frameset'
]);

const VOID_TAGS = new Set(['br', 'hr']);
const BLOCK_TAGS = new Set([
    'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'table', 'blockquote', 'pre', 'hr'
]);

// Attributes kept per tag. Anything not listed here is removed — this is what
// strips Word/Google Docs classes, `on*` handlers and inline styling.
const ATTRS_BY_TAG = {
    a: ['href', 'title'],
    table: ['border', 'cellpadding', 'cellspacing', 'width', 'align'],
    caption: ['align'],
    tr: ['align', 'valign', 'bgcolor'],
    td: ['colspan', 'rowspan', 'width', 'height', 'align', 'valign', 'bgcolor'],
    th: ['colspan', 'rowspan', 'width', 'height', 'align', 'valign', 'bgcolor', 'scope'],
    ol: ['start', 'type'],
    li: ['value'],
    p: ['align'],
    div: ['align'],
    h1: ['align'], h2: ['align'], h3: ['align'],
    h4: ['align'], h5: ['align'], h6: ['align']
};

const NUMERIC_ATTRS = new Set([
    'colspan', 'rowspan', 'width', 'height', 'border',
    'cellpadding', 'cellspacing', 'start', 'value'
]);
const COLOR_ATTRS = new Set(['bgcolor']);
const WORD_ATTRS = {
    align: ['left', 'right', 'center', 'justify'],
    valign: ['top', 'middle', 'bottom', 'baseline'],
    scope: ['row', 'col', 'rowgroup', 'colgroup'],
    type: ['1', 'a', 'A', 'i', 'I']
};

// Fixed presentation for table parts. The same markup has to look right in the
// app, in Gmail and in Outlook (whose Word engine ignores <style> blocks and
// needs the border attributes), so the styles are constants rather than
// anything taken from the incoming document.
const TABLE_STYLE = 'border-collapse:collapse;border:1px solid #d0d7de;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111111;';
const CELL_STYLE = 'border:1px solid #d0d7de;padding:6px 10px;text-align:left;vertical-align:top;';
const HEAD_CELL_STYLE = 'border:1px solid #d0d7de;padding:6px 10px;text-align:left;vertical-align:top;background:#f6f8fa;font-weight:bold;';

const NAMED_ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
    colon: ':', tab: '\t', newline: '\n', sol: '/', num: '#', semi: ';',
    hellip: '\u2026', mdash: '\u2014', ndash: '\u2013',
    lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d',
    bull: '\u2022', middot: '\u00b7', copy: '\u00a9', reg: '\u00ae',
    trade: '\u2122', deg: '\u00b0', pound: '\u00a3', euro: '\u20ac'
};

function escapeText(value) {
    return value.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Decodes the entity forms a browser would decode when it parses an attribute
// or a text node. One pass only — browsers do not decode twice, and neither
// does this, so `javascript&#38;#58;` stays inert exactly like it does in mail.
function decodeEntities(value) {
    return String(value)
        .replace(/&#x([0-9a-f]+);?/gi, (match, hex) => {
            const code = parseInt(hex, 16);
            return Number.isFinite(code) && code > 0 && code <= 0x10ffff
                ? String.fromCodePoint(code) : match;
        })
        .replace(/&#(\d+);?/g, (match, dec) => {
            const code = parseInt(dec, 10);
            return Number.isFinite(code) && code > 0 && code <= 0x10ffff
                ? String.fromCodePoint(code) : match;
        })
        .replace(/&([a-zA-Z]+);/g, (match, name) => {
            const resolved = NAMED_ENTITIES[name.toLowerCase()];
            return resolved === undefined ? match : resolved;
        });
}

// Only schemes that can do no harm in an email client or in the app's own log.
function safeHref(value) {
    if (typeof value !== 'string') return null;
    // Control characters and whitespace are how `java\nscript:` sneaks past a
    // naive check; a browser strips them the same way before resolving a URL.
    const stripped = value.replace(/[\u0000-\u0020\u007f-\u00a0]+/g, '');
    if (!stripped) return null;
    const decoded = decodeEntities(stripped);
    if (/^(https?:|mailto:|tel:)/i.test(decoded)) return stripped;
    if (/^(?:#|\/|\.\.?\/)/.test(decoded)) return stripped;
    return null;
}

// Index of the `>` that closes the tag starting at `start`, ignoring any `>`
// inside an quoted attribute value.
function findTagEnd(src, start) {
    let quote = null;
    for (let i = start + 1; i < src.length; i++) {
        const char = src[i];
        if (quote) {
            if (char === quote) quote = null;
        } else if (char === '"' || char === "'") {
            quote = char;
        } else if (char === '>') {
            return i;
        }
    }
    return -1;
}

function parseAttributes(rawTag) {
    const attrs = {};
    // Everything after the tag name, minus the closing bracket and any slash.
    const body = rawTag.replace(/^<\s*[a-zA-Z][a-zA-Z0-9:-]*/, '').replace(/>$/, '').replace(/\/$/, '');
    const re = /([a-zA-Z_:@][-a-zA-Z0-9_:.]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/g;
    let match;
    while ((match = re.exec(body)) !== null) {
        const name = match[1].toLowerCase();
        const value = match[3] !== undefined ? match[3]
            : match[4] !== undefined ? match[4]
                : match[5] !== undefined ? match[5] : '';
        if (!(name in attrs)) attrs[name] = value;
    }
    return attrs;
}

function isAcceptableAttrValue(name, value) {
    const clean = String(value).replace(/[<>"']/g, '').replace(/[\u0000-\u001f\u007f]/g, '');
    if (!clean || clean.length > 64) return false;
    if (NUMERIC_ATTRS.has(name)) return /^\d{1,4}%?$/.test(clean);
    if (COLOR_ATTRS.has(name)) return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(clean) || /^[a-z]{3,20}$/i.test(clean);
    const allowed = WORD_ATTRS[name];
    if (allowed) return allowed.includes(clean.toLowerCase()) || allowed.includes(clean);
    return /^[a-zA-Z0-9 _.,:;()\-+%#]*$/.test(clean);
}

// Returns the opening tag to emit, or null when the tag should be dropped
// altogether (disallowed tag, unsafe href, unacceptable attribute values).
function buildOpenTag(tag, rawTag) {
    const attrs = parseAttributes(rawTag);
    const allowed = ATTRS_BY_TAG[tag] || [];
    const parts = [];

    for (const name of allowed) {
        if (!(name in attrs)) continue;
        if (name === 'href') continue; // handled below, it needs its own test
        // Header shading is added after the fixed style below, so a header cell
        // always serialises in the same order.
        if (name === 'bgcolor' && tag === 'th') continue;
        if (!isAcceptableAttrValue(name, attrs[name])) continue;
        const clean = String(attrs[name]).replace(/[<>"']/g, '').replace(/[\u0000-\u001f\u007f]/g, '');
        parts.push(`${name}="${clean}"`);
    }

    if (tag === 'a') {
        const href = safeHref(attrs.href);
        if (!href) return null;
        parts.unshift(`href="${href.replace(/[<>"]/g, '')}"`);
        parts.push('target="_blank"', 'rel="noopener noreferrer"');
    }

    if (tag === 'table') {
        // Outlook's Word engine draws no borders unless they are attributes.
        if (!parts.some(part => part.startsWith('border='))) parts.push('border="1"');
        if (!parts.some(part => part.startsWith('cellpadding='))) parts.push('cellpadding="6"');
        if (!parts.some(part => part.startsWith('cellspacing='))) parts.push('cellspacing="0"');
        parts.push(`style="${TABLE_STYLE}"`);
    } else if (tag === 'td') {
        parts.push(`style="${CELL_STYLE}"`);
    } else if (tag === 'th') {
        parts.push(`style="${HEAD_CELL_STYLE}"`);
        const shading = ('bgcolor' in attrs && isAcceptableAttrValue('bgcolor', attrs.bgcolor))
            ? String(attrs.bgcolor).replace(/[<>"']/g, '')
            : '#f6f8fa';
        parts.push(`bgcolor="${shading}"`);
    }

    return `<${tag}${parts.length ? ' ' + parts.join(' ') : ''}>`;
}

/**
 * Reduce arbitrary HTML to the small subset this app sends and displays:
 * formatting, lists, links and tables survive; everything else (scripts,
 * event handlers, styles, classes, Word/Docs chrome) does not. Unbalanced
 * markup is closed so the result is always well-formed.
 */
export function sanitizeEmailHtml(html) {
    if (html === null || html === undefined) return '';
    const src = String(html);
    const out = [];
    const stack = [];
    let i = 0;

    const closeUpTo = (tag) => {
        const index = stack.lastIndexOf(tag);
        if (index === -1) return;
        for (let k = stack.length - 1; k >= index; k--) out.push(`</${stack.pop()}>`);
    };

    const openDefaultTable = () => {
        out.push(buildOpenTag('table', '<table>'));
        stack.push('table');
    };

    while (i < src.length) {
        const lt = src.indexOf('<', i);
        if (lt === -1) {
            out.push(escapeText(src.slice(i)));
            break;
        }
        if (lt > i) out.push(escapeText(src.slice(i, lt)));

        // Comments, doctypes and processing instructions carry no message.
        if (src.startsWith('<!--', lt)) {
            const end = src.indexOf('-->', lt + 4);
            i = end === -1 ? src.length : end + 3;
            continue;
        }
        if (src.startsWith('<!', lt) || src.startsWith('<?', lt)) {
            const end = src.indexOf('>', lt + 2);
            i = end === -1 ? src.length : end + 1;
            continue;
        }

        const tagEnd = findTagEnd(src, lt);
        if (tagEnd === -1) {
            out.push(escapeText(src.slice(lt)));
            break;
        }
        const rawTag = src.slice(lt, tagEnd + 1);
        i = tagEnd + 1;

        const parsed = /^<\s*(\/)?\s*([a-zA-Z][a-zA-Z0-9:-]*)/.exec(rawTag);
        if (!parsed) {
            out.push(escapeText(rawTag));
            continue;
        }
        const isClosing = !!parsed[1];
        const tag = parsed[2].toLowerCase();

        if (DROP_WITH_CONTENT.has(tag)) {
            if (!isClosing) {
                const closer = new RegExp(`</\\s*${tag}\\s*>`, 'i');
                const rest = src.slice(i);
                const found = closer.exec(rest);
                i = found ? i + found.index + found[0].length : src.length;
            }
            continue;
        }

        if (!ALLOWED_TAGS.has(tag)) continue;

        if (isClosing) {
            closeUpTo(tag);
            continue;
        }

        const isVoid = VOID_TAGS.has(tag) || /\/\s*>$/.test(rawTag);

        // Keep the tree balanced the way a browser would: a block closes the
        // paragraph it cannot live inside, list items and table cells close
        // their predecessors, and stray cells get the structure they need.
        if (tag === 'p') closeUpTo('p');
        else if (BLOCK_TAGS.has(tag) && stack.includes('p')) closeUpTo('p');
        else if (tag === 'li') {
            closeUpTo('li');
            if (!stack.includes('ul') && !stack.includes('ol')) {
                out.push('<ul>');
                stack.push('ul');
            }
        } else if (tag === 'tr') {
            closeUpTo('tr');
            if (!stack.includes('table')) openDefaultTable();
        } else if (tag === 'td' || tag === 'th') {
            closeUpTo('td');
            closeUpTo('th');
            if (!stack.includes('tr')) {
                if (!stack.includes('table')) openDefaultTable();
                out.push('<tr>');
                stack.push('tr');
            }
        } else if (tag === 'a') {
            closeUpTo('a');
        }

        const openTag = buildOpenTag(tag, rawTag);
        if (!openTag) continue;
        out.push(openTag);
        if (!isVoid) stack.push(tag);
    }

    while (stack.length) out.push(`</${stack.pop()}>`);
    return out.join('');
}

/**
 * Plain-text rendering of the same message: what goes into the compose links,
 * onto the clipboard as a fallback, and into the communication log. Falls back
 * to a DOM-free scan so it behaves identically in Node.
 */
export function htmlToPlainText(html) {
    if (!html) return '';
    let src = String(html);
    src = src.replace(/<!--[\s\S]*?-->/g, '');
    src = src.replace(/<(script|style|head|title|noscript|template|iframe)[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
    src = src.replace(/<li[^>]*>/gi, '\u2022 ');
    src = src.replace(/<\/(p|div|h[1-6]|blockquote|pre|tr|li|ul|ol|table|thead|tbody|tfoot|caption|section|article|header|footer)\s*>/gi, '\n');
    src = src.replace(/<(br|hr)\s*\/?>/gi, '\n');
    src = src.replace(/<\/(td|th)\s*>/gi, '\t');
    src = src.replace(/<t[dh][^>]*>/gi, '');
    src = src.replace(/<[^>]*>/g, '');
    src = decodeEntities(src);

    return src
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n[ \t]+/g, '\n')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// True when the message carries anything a compose link cannot express — bold,
// lists, links, tables, headings. Paragraphs and line breaks alone are plain
// text and keep the old behaviour.
export function hasRichFormatting(html) {
    if (!html) return false;
    const re = /<\s*\/?\s*([a-zA-Z][a-zA-Z0-9-]*)/g;
    let match;
    while ((match = re.exec(html)) !== null) {
        const tag = match[1].toLowerCase();
        if (tag === 'p' || tag === 'div' || tag === 'br') continue;
        return true;
    }
    return false;
}

export function escapeHtml(value) {
    return String(value === null || value === undefined ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function clipboardFragment(html) {
    // A wrapper so Outlook's Word engine starts from Arial instead of Times,
    // and so pasted fragments keep a sane size wherever the wrapper survives.
    return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#111111;">${html}</div>`;
}

// Copies HTML using a hidden selection, which every browser turns into both a
// `text/html` and a `text/plain` flavour on the clipboard. Synchronous on
// purpose: the compose window is opened in the same click, and this has to
// finish before focus moves to another tab.
function copyHtmlViaSelection(html) {
    if (typeof document === 'undefined' || !document.execCommand) return false;
    const host = document.createElement('div');
    host.setAttribute('contenteditable', 'true');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;';
    host.innerHTML = html;
    document.body.appendChild(host);

    let ok = false;
    try {
        const range = document.createRange();
        range.selectNodeContents(host);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        ok = document.execCommand('copy');
        selection.removeAllRanges();
    } catch {
        ok = false;
    }
    document.body.removeChild(host);
    return ok;
}

function copyTextViaTextarea(text) {
    if (typeof document === 'undefined') return false;
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:0;left:0;width:2em;height:2em;padding:0;border:none;outline:none;box-shadow:none;background:transparent;';
    document.body.appendChild(area);
    let ok = false;
    try {
        area.focus();
        area.select();
        ok = document.execCommand('copy');
    } catch {
        ok = false;
    }
    document.body.removeChild(area);
    return ok;
}

/**
 * Put the formatted message on the clipboard.
 *
 * @returns {Promise<'html'|'text'|'failed'>} 'html' means the paste will carry
 * the formatting; 'text' means the browser only allowed a plain-text copy.
 */
export async function copyRichToClipboard(html, plainText = '') {
    const fragment = clipboardFragment(String(html || ''));
    const fallbackText = plainText || htmlToPlainText(html);

    try {
        if (copyHtmlViaSelection(fragment)) return 'html';
    } catch {
        // Fall through to the async clipboard API.
    }

    try {
        if (typeof ClipboardItem !== 'undefined' && navigator.clipboard && navigator.clipboard.write) {
            await navigator.clipboard.write([
                new ClipboardItem({
                    'text/html': new Blob([fragment], { type: 'text/html' }),
                    'text/plain': new Blob([fallbackText], { type: 'text/plain' })
                })
            ]);
            return 'html';
        }
    } catch {
        // Permission denied or unsupported flavour — try plain text.
    }

    try {
        if (navigator.clipboard && navigator.clipboard.writeText && fallbackText) {
            await navigator.clipboard.writeText(fallbackText);
            return 'text';
        }
    } catch {
        // Fall through to the legacy textarea.
    }

    try {
        if (fallbackText && copyTextViaTextarea(fallbackText)) return 'text';
    } catch {
        // Nothing worked; the caller tells the user to copy manually.
    }

    return 'failed';
}
