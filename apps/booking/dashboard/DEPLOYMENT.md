# LIER deployment

## Current boundary

The dashboard is a password-protected, single-user Node 26 application with local SQLite storage. Its listener deliberately refuses non-loopback binding. No production deployment, hosted team access or live provider connection has been verified.

The local implementation uses Node HTTP, filesystem access and `node:sqlite`. It cannot be deployed unchanged as a Cloudflare Worker or D1 application. A hosted release needs a compatible persistent Node runtime or an explicit runtime and storage adaptation. Do not expose or reverse-proxy the development listener to the public internet.

## Configuration and data

- Configure application settings with `LIER_*` environment variables and provider credentials with the names in `backend/.env.example`.
- For an existing local workspace, set `LIER_DB_PATH` to its existing database and update application configuration to `LIER_*` before starting. Preserve the database and stable artist IDs; changing the product configuration does not require rebuilding stored evidence.
- Keep runtime databases, passwords, provider tokens and private event records outside application source and static assets. Use managed secrets and access-controlled persistent storage when hosting.
- Retain source-specific access and expiry rules. Add an unattended retention process and verify backup/export expiry before collecting continuously.
- Record database migrations explicitly. Test backup restoration and rollback against the exact application and schema versions intended for deployment.

## Authentication requirements

Every hosted dashboard and data API must remain password protected. Local startup requires `LIER_DASHBOARD_PASSWORD` with at least 12 characters and has no default password. The password must never be supplied in frontend files, source control, public logs or API responses.

The local service has HttpOnly SameSite=Strict cookies, absolute session expiry, logout, login rate limiting and origin checks. A hosted adaptation must retain those controls, serve HTTPS and use Secure cookies. The local HTTP cookie configuration is not a production configuration.

A shared password does not establish user accounts, workspace membership, roles or tenant isolation. Define and test those boundaries before making the application a shared team service. Do not infer permission to read another workspace from an artist ID or provider identifier.

## Release sequence

1. Select the hosting runtime and persistent database, then document the application entry point, secret injection and storage bindings.
2. Preserve the source, assets and schema version needed for rollback. Keep database backups private and verify restoration before a release that changes persistent state.
3. Adapt and test the HTTP, storage and authentication layers for the selected runtime. Keep source acquisition credentials server-side and retain strict validation at persistence boundaries.
4. Run the automated suite and a real-socket/browser smoke test. Verify unauthenticated API rejection, login failure and success, session expiry, logout, cross-origin rejection, roster persistence and authorized evidence imports.
5. Deploy an identified source commit with the required configuration. Verify HTTPS, authenticated page/API behavior, persistent data, request failures and rollback in the actual hosted environment.
6. Establish source access separately: collect and inspect a real authorized observation before describing any provider as live connected.

## Verification limits

The automated suite uses controlled provider responses, temporary SQLite databases and the actual HTTP request handler in process. The authoring environment denied loopback listeners with `listen EPERM`; real-socket and browser QA remain unverified. A separate TypeScript compiler check has not been run.

A passing local test suite does not establish a successful hosted release, live source coverage, shared-workspace authorization or payment processing. Record those acceptance results separately when they are performed.
