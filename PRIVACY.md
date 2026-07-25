# Privacy Policy — Batch Emailer

**Last updated:** July 24, 2026

## Overview

Batch Emailer is a client-side web application for contact management and batch email drafting. This policy explains what data is collected, how it is stored and protected, and your rights regarding that data.

## Data Collected

Batch Emailer collects the following personal information that you enter:

- **Contact names**
- **Email addresses** (one or more per contact)
- **Notes** (free-text field for additional details)
- **Communication history** (timestamps and message content for emails drafted through the application)
- **Group/folder organization** (names and structure you create)

## How Data Is Stored

All data is stored **exclusively in your browser** using:

- **localStorage** — Active application data
- **IndexedDB** — Automatic background backups

No data is transmitted to any server, cloud service, or third party. There is no backend component.

## Data Protection

### Encryption at Rest

- **Exported backup files** are encrypted using AES-256-GCM with PBKDF2 key derivation (100,000 iterations, SHA-256). A password of your choosing is required to encrypt and decrypt backups.
- **Automatic IndexedDB backups** are encrypted using the same AES-256-GCM standard when you set an encryption password.

### Access Control

- Data is accessible only to anyone who has physical or browser access to your device.
- There is no account system, no login, and no remote access.
- No session timeout is enforced — you are responsible for securing your device.

## Data Retention

- Data is retained in your browser until you manually delete it or clear browser storage.
- There is no automatic expiration or retention limit.
- You can delete all data at any time through the application's settings or by clearing your browser's localStorage and IndexedDB for this site.

## Third-Party Services

- **Email composition** (Gmail, Outlook, mailto) — When you choose to compose an email, recipient addresses, subject lines, and message content are passed to your email provider via URL parameters. This is initiated by you and is not automatic.
- **CDN scripts** — PDF generation libraries are loaded from cdnjs.cloudflare.com at runtime. These requests may log your IP address per the CDN's standard access logs. No personal data from your contacts is sent to the CDN.

## Your Rights

Under FIPPA (Freedom of Information and Protection of Privacy Act) and applicable privacy laws, you have the right to:

- **Access** — View all personal information stored by this application at any time.
- **Correction** — Edit or update any personal information.
- **Deletion** — Delete any or all personal information.
- **Export** — Download a complete, encrypted backup of your data.

## Children's Privacy

This application may be used to manage contact information for students or minors. Users are responsible for ensuring they have appropriate authorization to collect and store such information. The application itself does not distinguish between adult and minor contacts.

## Changes to This Policy

This policy may be updated as the application evolves. The "Last updated" date at the top reflects the most recent revision.

## Contact

For questions about this privacy policy or the application's data practices, please open an issue at the project's GitHub repository.
