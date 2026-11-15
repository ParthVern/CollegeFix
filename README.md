# CampusFix

CampusFix is a responsive campus issue-reporting app. Students can report a problem, attach a photo, and follow its status. Campus administrators can search reports, set priorities, reply, and record status changes.

## Run CampusFix

1. Install [Node.js 24 or newer](https://nodejs.org/).
2. Open a terminal in this project folder.
3. Run `npm install` once, then `npm start`.
4. Open **http://127.0.0.1:3000** in your browser.
5. Press **Ctrl+C** in the terminal to stop the server.

For development, `npm run dev` restarts the server when a project file changes. Run `npm test` to check the main account, reporting, authorization, update, notification, and upload workflows.

The application keeps its SQLite database, session-signing key, and uploaded photos in the automatically created `data/` folder. This folder contains private operational data and is intentionally ignored by Git.

## Demo accounts

| Account | Email | Password |
| --- | --- | --- |
| Student | `student@campusfix.edu` | `CampusFixStudent!2026` |
| Administrator | `admin@campusfix.edu` | `CampusFixAdmin!2026` |

Use the **Student demo** and **Admin demo** buttons on the sign-in page to fill in these credentials. New accounts are always students; administrator access is not available through public registration.

Five example reports are added when the database is first created. They show a variety of categories, priorities, statuses, update histories, and student notifications.

## What’s included

- **Student accounts:** student registration, sign-in/sign-out, a personalized dashboard, report history, search and status/category filters, photo uploads, detailed status timelines, and update notifications.
- **Campus administration:** role-restricted admin sign-in, a campus-wide dashboard and report list, search and filters, priority and status updates, and responses to students.
- **Complaint workflow:** Submitted → Under Review → In Progress → Resolved / Rejected. Each transition records who changed the status, when, and the accompanying update.
- **Security protections:** scrypt password hashes, signed and expiring HTTP-only session cookies, per-session CSRF tokens, same-origin checks, role and ownership checks, request validation, sign-in throttling, restrictive browser security headers, and private, type-checked JPEG/PNG/WebP photo storage.
- **Local persistence:** SQLite is built into supported recent Node.js versions, so a separate database server or native SQLite dependency is not needed.

## Project layout

- `server.js` — Express application, SQLite schema, demo data, authentication, and API routes.
- `public/index.html` — the web page loaded by the browser.
- `public/app.js` — dashboards, forms, charts, filters, and interactive workflows.
- `public/styles.css` — responsive CampusFix design.
- `public/favicon.svg` — application icon.
- `test/app.test.js` — automated API and security workflow tests.
- `data/` — created automatically for the database, private photos, and session key; do not share or commit it.

## Configuration and notes

- `PORT` changes the web-server port (default `3000`).
- `HOST` changes its network interface (default `127.0.0.1`). Only expose the app publicly behind HTTPS and a production-grade host.
- `SESSION_SECRET` can provide an externally managed session-signing secret. If unset, CampusFix creates a private random key in `data/.session-secret`.
- `NODE_ENV=production` enables secure session cookies, HSTS, and longer static-asset caching; HTTPS is required in that mode.
- Demo accounts are for presentations, not real deployments. Change demo credentials, use HTTPS, configure backups, and replace the built-in demo-data policy before hosting sensitive or production data.
- Notifications are stored in the app and appear in the signed-in student’s notification list; this project does not send email or push notifications.
- Images are limited to 3 MB and are served only after the viewer passes the same student-ownership check as the complaint itself.
