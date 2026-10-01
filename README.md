# Kozeta Salon — private code handoff

This is a fresh source snapshot, not an automatically synchronized mirror of the live Replit project.

## Start here
Read `handover/Kozeta-Website-Migration-Handover.pdf` (also supplied as HTML). It includes domain/email findings, current feature flags, provider configuration names, costs, migration options, and cutover checks.

## Run
Use a compatible Node.js runtime (Node 20 is a starting point; verify against dependencies). Run `npm ci`, `npm run check`, `npm run build`, then `npm start`. Development: `npm run dev`. Port defaults to 5000.

Configure provider credentials and database access securely before starting. Import-time AI clients may require valid provider configuration even with chat disabled. No secrets or customer database are included. Do not run db:push on production without approval and a backup.

## Preserve current behavior
PORTAL_ENABLED=false; LOGIN_ENABLED=true. Booking/deposits stay with Phorest. Do not enable custom Stripe/AI flows or issue real payments/refunds as tests.

## Contents and exclusions
Includes current frontend/backend/shared code, tests, build/deployment configuration, required website media, and handover documents. Excludes historical Git commits, original uploaded reference screenshots/raw media not needed by the site, agent/session logs, runtime data, private credentials, node_modules, and build output. Historical project notes are omitted in favor of the curated handover.

The source snapshot was checked for common embedded credential patterns; this is not a complete security audit. Review before expanding access. Database exports and secrets must be transferred separately through approved secure channels.

## Access
Keep this repository private. Owner grants named collaborators access; receiving the URL alone does not grant access. Website/domain/mail changes require owner approval.
