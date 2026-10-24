# Archflow

Archflow is a dependency-free, self-hosted architecture diagram workspace. It combines a browser canvas with a small Node.js modular monolith and SQLite database. The repository was empty, so this setup avoids a package installation step and keeps the server, editor, and persistence model easy to run locally.

## Run locally

Requires Node.js 24 or newer. The built-in `node:sqlite` module is used; no npm packages are needed.

```sh
node server.mjs
```

Open [http://localhost:4173](http://localhost:4173). The app creates `data/archflow.sqlite` on first start and seeds an evaluation workspace:

- Email: `demo@archflow.local`
- Password: `Diagram!2026`

Choose **Explore the demo** on the landing page to sign in without typing those credentials. The sample workspace contains a Northstar Commerce project and a realistic storefront diagram. Keep the demo account for local evaluation only; change or remove its credentials before making a deployment accessible to other people.

### Environment

Copy `.env.example` as a reference. The application does not load `.env` files automatically; set the variables in your shell or deployment environment.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4173` | HTTP listen port |
| `ARCHFLOW_DATA_DIR` | `./data` | Directory for the SQLite database and its WAL files |
| `NODE_ENV` | `development` | Enables the `Secure` session cookie attribute when set to `production` |

Use a persistent, writable volume for `ARCHFLOW_DATA_DIR`. Put the server behind HTTPS in production. Password hashes use Node's `scrypt`; session tokens are random, stored as SHA-256 hashes, and sent in HttpOnly, SameSite cookies. Secrets are not committed to source control.

### Docker

```sh
docker build -t archflow .
docker run --rm -p 4173:4173 -v archflow-data:/app/data -e NODE_ENV=production archflow
```

The health endpoint is `GET /api/health`. The server writes structured startup and error events to stdout/stderr. SQLite runs in WAL mode with foreign keys and a busy timeout enabled.

## What works

- Sign up, sign in/out, local password recovery flow, profile and password settings.
- Private workspaces, invitations, membership management, and server-enforced Owner, Editor, and Viewer roles.
- Project create, edit, search, sort, duplicate, archive, restore, and delete, with paginated list responses.
- Multiple diagrams per project, starter templates, a component palette, custom component definitions, and a canvas navigator.
- General diagram shapes (rectangles, rounded boxes, ellipses, and diamonds), drag-to-draw boxes, freehand pen strokes, and keyboard text notes with standard or handwritten-style typography. Double-click the canvas to add a note; select P, T, or B for the pen, text, or box tools.
- Canvas pan and zoom, fit-to-view, grid display, snap-to-grid, minimap, selection, multi-select, drag, resize, copy/paste, grouping, alignment, layers, and keyboard shortcuts.
- Directional labeled connectors, endpoint changes, an inspector for node and connector data, basic validation, and automatic layout.
- Debounced delta operations, saved revisions, restore and inspection of revisions, offline local drafts, and an explicit optimistic conflict state.
- Comments attached to a component or a canvas point, view-only expiring share links, and JSON, SVG, PNG, and print-to-PDF exports.
- Health check, SQLite indexes, server-side validation, same-origin requests, and workspace authorization checks for every private data operation.

## Structure

- `server.mjs` — HTTP server, SQLite schema, authentication, authorization, validation, persistence, and API routes.
- `public/index.html` — browser entry point.
- `public/app.js` — client-side routing, dashboard, editor, canvas renderer, and API client.
- `public/styles.css` — responsive visual system.
- `FORMAT.md` — editable diagram JSON format and compatibility policy.
- `Dockerfile` — container entry point with an external persistent data volume.

The editor uses a 2D canvas and culls drawing to the current viewport. Small edits are sent as node, edge, or layer operations rather than whole-diagram snapshots. SQLite stores a complete revision snapshot after each accepted save batch, retaining the latest 40 revisions per diagram.

## Collaboration and deployment limits

This version uses optimistic concurrency on diagram revisions. A second editor can work, but simultaneous saves do not merge automatically: a stale save is rejected with `409`, and the editor keeps the local draft available for download or reload. There is no live cursor/presence or CRDT collaboration layer yet. The data model and operation endpoint are ready for a real-time transport to be added later.

Password recovery generates a one-hour, single-use reset token. In local development the reset URL is written to the server log. A production email delivery adapter, rate limiting, and abuse monitoring still need to be configured before exposing recovery publicly. The UI does not pretend to send an email when no mail provider exists.

The server accepts diagrams up to 10,000 components, 20,000 connections, and 5 MB serialized JSON. A local browser run with a synthetic 1,000 component / 2,000 connection fixture measured a 39.1 ms first full draw and 7.2–13 ms on four subsequent zoom redraws. These timings include the minimap and were captured on the development machine; the hardware/browser environment was not recorded, so they do not establish performance on a representative laptop. The renderer builds a node ID map per frame so edge lookup stays linear in diagram size. The browser export path is synchronous, and PDF export uses the browser print dialog rather than a server-side export queue. Large exports should be tested on the target deployment before promising a latency or file-size envelope.

## Data and security notes

- Each project is scoped to a workspace; each private API route resolves membership from the signed-in user before returning or modifying data.
- Owners manage members and invitations; Editors can edit projects and diagrams; Viewers can read private diagrams; public share tokens provide view-only access until expiry.
- The included local demo credentials are intentionally public examples and must not be treated as production credentials.
- Configure HTTPS, persistent storage, database backups, monitoring, outbound email, request rate limits, and an operational restore policy before production use.
