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
- **Archive & Restore** — Soft-archive folders and groups without losing data
- **Collapsible Sidebar** — Responsive navigation that auto-collapses on mobile

</td>
<td width="50%">

### 👥 Manage Contacts
- **Multiple Emails per Contact** — Store unlimited email addresses per person
- **Bulk Import** — Paste tab-separated data or upload a CSV file with auto-detected headers
- **Shift-click Range Selection** — Select multiple contacts with a single gesture
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
- **Communication History** — Every sent email is timestamped and logged per contact
- **PDF Reports** — Export a formatted group report with full email history as a PDF via `jsPDF`
- **Print View** — Browser-native print layout optimized for clean, compact output
- **JSON Backup** — Export / import your entire dataset; supports both replace and append modes

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
│   └── generate_favicons.py   # Favicon generation utility
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
| **1** | Create a **Folder** (e.g. *"2025-2026 School Year"*) |
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
