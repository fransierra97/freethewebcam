# Security policy

Please **do not open public issues for security vulnerabilities**.

Report them privately through GitHub's "Report a vulnerability" button (Security → Advisories) on this repository.
Include steps to reproduce, the affected version and the impact. We aim to acknowledge reports within a few days.

## Scope

Especially relevant: authentication and sessions, access control (rooms, private shows, albums, admin), payments and
the ledger, webhook verification, file uploads and encrypted storage, personal data and performer records.

## Operators

If you run an installation: keep `.env` secret and backed up, run `./ftw update` regularly, restrict SSH access,
and keep all providers in live mode only after testing them.
