# LIER booking workspace

This is LIER's first implemented module. It contains the `backend/` ingestion engine and `dashboard/` local application.

Commands and relative setup paths in the dashboard guide are relative to this directory. The repository-root scripts delegate here, so `npm test`, `npm run dashboard` and `npm run sources` also work from the LIER root.

Application configuration uses `LIER_*` environment keys. Provider credentials use the provider-specific names documented in `backend/.env.example`. Configuration and stored artist identifiers do not establish tenant isolation; workspace membership and authorization must be introduced before hosting multiple independent teams.

See [dashboard setup](dashboard/README.md), [source feasibility](backend/docs/SOURCE-MAP.md), and the repository's [product scope](../../docs/PRODUCT-SCOPE.md).
