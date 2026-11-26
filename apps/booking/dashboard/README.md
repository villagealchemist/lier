# Fold Theory dashboard

This is the Fold Theory workspace within LIER. Setup paths and commands below are relative to `apps/booking`; repository-root scripts delegate to this module.

A password-protected local interface to the existing ingestion backend. The workspace stores artists and preferences in SQLite, reads provider evidence with its provenance, accepts authorized evidence imports, and helps calculate a booking scenario's break-even attendance.

## Start

Requires Node 26 or newer. No package installation is required.

1. From `apps/booking`, copy `backend/.env.example` to `backend/.env`.
2. In that untracked file, set `FOLD_DASHBOARD_PASSWORD` to a password of at least 12 characters. There is no default password. Do not put credentials in frontend files.
3. Run:

```sh
npm run dashboard
```

Open the local URL printed by the server and sign in. The default port is 4317; `FOLD_DASHBOARD_PORT` can override it. The service binds only to loopback and refuses a public network binding. `FOLD_DB_PATH` and `FOLD_POLICY_FILE` use the backend working directory, matching the existing CLI. Stop the server with Ctrl+C.

This is a local single-user workspace, not a shared team service. The original foldtheory.fyi domain remains on Friendsgiving until the source/hosting transition is completed. See [DEPLOYMENT.md](DEPLOYMENT.md).

## Working with artists

- Add an artist by name, with optional genre and target market. Shortlist artists and record taste, fee assumptions and notes separately from measured evidence.
- Add reviewed provider IDs to collect through configured backend adapters. Names alone never establish identity.
- View platform counters, audience reports, event listings and actual show outcomes in separate evidence sections. Missing or hidden measurements are not zero; events do not imply paid attendance.
- Import the backend's authorized JSON report format. The dashboard rejects synthetic imports. See `../backend/examples/README.md` for the schema; the example files are fictional and intentionally not accepted as real evidence.
- Use the booking calculator for your own assumptions. Break-even attendance is arithmetic, not a ticket-sales forecast or artist recommendation.

Roster fees and the first booking calculator use USD. Imported organizer reports retain their own currency and minor-unit precision; the dashboard does not convert them to USD. An artist with retained evidence or a collected identity cannot be removed through the roster UI, because that would make the evidence inaccessible. Remove the artist from the shortlist instead. Audience imports must reference registered roster IDs; find the ID in the artist editor. Whole-event reports must include at least one registered artist, and any other lineup IDs remain explicitly unlinked.

Provider configuration is server-side only. Every source starts disabled and credentials remain in the untracked environment file. The Sources view shows configuration and known field gaps; configuration alone does not prove live coverage. API keys and tokens are never accepted through the dashboard's browser forms.

## Password protection

Data APIs require an authenticated session. Session cookies are HttpOnly with SameSite=Strict and a bounded lifetime; logout invalidates the session. Mutations require the correct origin and a request header. Repeated failed sign-ins are rate limited. Passwords are not written to the database or included in responses.

Local preview uses HTTP on loopback, so the session cookie is not marked Secure. A hosted implementation must use HTTPS/Secure cookies and retain the existing production password protection. Do not expose or reverse-proxy this development server to the public internet.

## Validation

```sh
npm test
```

Run this from the repository root or `apps/booking` for backend and dashboard tests together. Tests use temporary databases and fixture responses. No live artist source credentials, production password, or RSVP records are required by tests. TypeScript runs with Node's type stripping; no separate compiler type check has been completed.

The authoring environment denied a loopback listener with `listen EPERM`, so a running HTTP server and browser interactions could not be verified here. HTTP behavior is tested through the actual request handler in process. Those tests do not establish a successful browser session or deployed service. Real socket/browser smoke testing remains required in an environment that permits a local server.

The explicit socket smoke test can be run from `apps/booking` in that environment:

```sh
FOLD_DASHBOARD_SOCKET_TESTS=1 node --test dashboard/tests/server.socket.ts
```

It uses a temporary in-memory database and a fixture password. It is not included in the ordinary test glob and has not passed in this restricted environment.
