# LIER booking workspace

This is LIER's first implemented module, initially configured and branded for the Fold Theory collective. It contains the existing `backend/` ingestion engine and `dashboard/` local application.

Commands and relative setup paths in the dashboard guide are relative to this directory. The repository-root scripts delegate here, so `npm test`, `npm run dashboard` and `npm run sources` also work from the LIER root.

Existing `FOLD_*` environment keys and persisted identifiers are retained for compatibility. They are not a tenant-isolation mechanism. Workspace configuration, membership and authorization must be introduced before hosting multiple collectives.

See [dashboard setup](dashboard/README.md), [source feasibility](backend/docs/SOURCE-MAP.md), and the repository's [product scope](../../docs/PRODUCT-SCOPE.md).
