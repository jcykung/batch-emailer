<div align="center">

# ✉️ Batch Emailer

**A sleek, privacy-first contact management and batch email tool for educators and teams.**

Organize contacts into folders and groups, compose messages, and send batch emails through Gmail, Outlook, or your default mail client — all from a single-page app that runs entirely in your browser.

[![MIT License](https://img.shields.io/badge/License-MIT-a9dc76?style=for-the-badge)](LICENSE)
[![React 18](https://img.shields.io/badge/React-18-78dce8?style=for-the-badge&logo=react&logoColor=white)](https://react.dev)
[![Vite](https://img.shields.io/badge/Vite-5-ab9df2?style=for-the-badge&logo=vite&logoColor=white)](https://vitejs.dev)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-4-fc9867?style=for-the-badge&logo=tailwindcss&logoColor=white)](https://tailwindcss.com)

</div>

---

## ✨ Features

<table>
<tr>
<td width="50%">

### 📁 Organize
- **Folders & Groups** — Nest contact groups inside folders for clean hierarchical organization
- **Pinned Favourites** — Pin a folder *or* a group (hover → pin icon, or right-click → Pin) and it is listed in the collapsible **Pinned** section at the top of the sidebar; pinned groups show which folder they live in, and the **Groups** section (also collapsible) holds the full folder tree with a **+** button that adds a new folder
- **Archive & Restore** — Soft-archive folders and groups without losing data
- **Drag & Drop Ordering** — Drag folders to rearrange the folder list; drag groups to reorder them or to move them into another folder (drop on the folder row — it opens as you hover). The Pinned section mirrors the same rows, so dragging works there too and the Groups list updates live, and the new order syncs and shows up in conflict reports like any other change
- **Collapsible Sidebar** — Responsive navigation that auto-collapses on mobile

</td>
<td width="50%">

### 👥 Manage Contacts
- **Multiple Emails per Contact** — Store unlimited email addresses per person
- **Bulk Import** — Paste spreadsheet rows, a table copied out of Google Docs/Sheets, comma separated values, or a plain name-above-its-emails list (or upload a `.csv`/`.tsv` file). Header rows are skipped, every address is captured, and each import stops at an **editable review step** so you can fix, delete or skip rows before anything is added
- **Group-scoped Duplicates** — The review step's **Skip contacts already in "…"** option only compares against the group you're importing into; a person who exists in some other group is never treated as a duplicate here
- **Standard Selection** — Click to select, `Ctrl`/`Cmd`+click to toggle, `Shift`+click for a range
- **Delete Contacts** — Remove one contact or many at once from the row's trash button, the right-click menu, the "Delete Selected" button, or the `Delete` key (always with confirmation)
- **Notes Field** — Attach context to any contact

</td>
</tr>
<tr>
<td width="50%">

### ✉️ Compose & Send
- **Draft Mass Emails** — Write a subject line and message body, then open the composed draft in your email service
- **Gmail · Outlook · Default App** — One-click launch with BCC, subject, and body pre-filled
- **Auto-batching** — Large recipient lists are automatically split to respect provider limits
- **Clipboard Helpers** — Copy BCC lists and message bodies with a single click

</td>
<td width="50%">

### 📊 Track & Export
- **Communication History** — Every sent email is timestamped and logged per contact, including the subject line and full message body
- **PDF Reports** — Export a formatted group report with full email history as a PDF via `jsPDF`
- **Print View** — Browser-native print layout optimized for clean, compact output
- **JSON Backup** — Export / import your entire dataset; supports both replace and merge modes, and every file is verified after writing so folders, groups, contacts, notes, **email messages** and settings are all provably present

</td>
</tr>
</table>

### 🎨 Additional Highlights

- 🌙 **Dark & Light Themes** — Monokai Pro-inspired dark mode with a warm light alternative
- 🔒 **100% Client-Side** — All data lives in `localStorage`; nothing is ever sent to a server
- 📱 **Fully Responsive** — Desktop sidebar layout gracefully adapts to mobile with overlay navigation
- ⚡ **Zero Backend** — No accounts, no databases, no API keys — just open and use

---

## 🚀 Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 18+ and npm

### Installation

```bash
# Clone the repository
git clone https://github.com/jcykung/batch-emailer.git
cd batch-emailer

# Install dependencies
npm install

# Start the dev server
npm run dev
```

The app will be available at `http://localhost:5173`.

### Build for Production

```bash
npm run build
npm run preview   # Preview the production build locally
```

### Verify

```bash
npm run verify            # all suites
npm run verify-backup     # backup/sync files round-trip completely
npm run verify-import     # contact import parses every supported format
npm run verify-sidebar    # sidebar Pinned/Groups structure renders correctly
```

`verify-backup` round-trips a realistic dataset through encrypt → write → read → verify, and confirms that missing contacts, missing **email messages** or missing settings make verification fail loudly. `verify-import` feeds the pasted formats a real user might copy (Docs tables, stacks of names and emails, CSV with quoted commas) through the parser. `verify-sidebar` renders the app server-side to confirm the sidebar keeps its Pinned and Groups sections, that pinned folders *and* groups appear both in Pinned and in their place in the tree, that the divider arrow replaced the hamburger, that folder/group **drag & drop ordering** (including order-only sync differences) behaves, and that the empty states are correct. Run them after touching the backup, import or sidebar code.

---

## 🗂️ Project Structure

```
batch-emailer/
├── index.html            # App entry point
├── vite.config.js        # Vite + React + Tailwind config
├── package.json
├── public/               # Favicons & static assets
│   ├── favicon.svg
│   └── favicon-*.png
├── scripts/
│   ├── generate_favicons.py   # Favicon generation utility
│   ├── verify_backup_integrity.mjs  # Round-trip test for backup/sync completeness
│   ├── verify_contact_import.mjs    # Parser tests for every supported paste format
│   └── verify_sidebar.mjs           # Server-rendered sidebar structure checks
├── src/
│   ├── main.jsx          # React root mount
│   ├── App.jsx           # Entire application (single-file SPA)
│   └── index.css         # Tailwind entry
└── dist/                 # Production build output
```

---

## 🖥️ Usage

| Step | Action |
|------|--------|
| **1** | Create a **Folder** (e.g. *"2025-2026 School Year"*) — press the **+** beside the **Groups** sidebar heading |
| **2** | Add a **Group** inside the folder (e.g. *"Period 1 — Algebra"*) |
| **3** | Add **Contacts** individually, paste a bulk list, or import a CSV |
| **4** | Select contacts → click **Draft Email** |
| **5** | Write your subject and message → choose **Gmail**, **Outlook**, or **Default App** |
| **6** | The email opens pre-filled — review, then send. The message is logged locally. |

---

## 🛠️ Tech Stack

| Layer | Technology |
|-------|-----------|
| **UI Framework** | React 18 |
| **Build Tool** | Vite 5 |
| **Styling** | Tailwind CSS 4 |
| **Icons** | Lucide React |
| **PDF Export** | jsPDF + AutoTable (loaded on demand from CDN) |
| **Persistence** | Browser `localStorage` |

---

## 📄 License

This project is licensed under the **MIT License** — see the [LICENSE](LICENSE) file for details.

<div align="center">

---

Made with ☕ by [coOLcAT](https://github.com/jcykung)

</div>
