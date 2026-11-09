# Storage for partner-lab imports

MGPL sends some samples to partner labs (Hy Patho Lab, Clinova Pathlabs). The api reads each partner's PDF
with `@mgpl-diagnostics/report-reader` and keeps what it found here. db-kit stores; the rules (matching,
mapping, who may see a signature) live in the api.

| Repository | Table / collection | One row per | Notes |
| --- | --- | --- | --- |
| `externalReports` | `external_reports` | uploaded PDF | `sourceSha256` **unique per organisation** (the same PDF uploaded twice is one row); `extracted` is report-reader's `ExtractedReport`, as is; `status` extracted → matched → applied, or rejected; `warnings` |
| `externalReportFiles` | `external_report_files` | PDF (id = the external report's id) | the original bytes, apart from the row so that lists never load them |
| `externalSignatories` | `external_signatories` | partner doctor or signer | the signature registry (`KnownSignature` for report-reader): name, qualification, registration, title, role, `sha[]`, `dhash[]`; `listForOrg(orgId, lab?)` is cached per organisation when Redis is configured, and cleared on every write |
| `externalSignatures` | `external_signatures` | (organisation, `sourceSha256`, signature `sha`) | the PNG from that PDF, unique per PDF and signature |
| `reportProvenance` | `report_provenance` | our report (unique `reportId`) | where its results came from: external report, `sourceSha256`, lab, performed by / at, medical signatories, NABL text (only for tests the partner marked), the partner's test name, sample id, reported time, and the results **as imported** (for audit when staff edit them) |

Every row carries `orgId`. Bytes (`pdf`, `png`) are `Uint8Array` in, `Buffer` out on both backends
(PostgreSQL `BYTEA`, MongoDB `Buffer`).

## Privacy

The PDF, the extracted JSON and the signature images are patient or personal data. They stay in these
tables, scoped to the organisation. Never log them, never put them in fixtures or repositories. Tests
use fictional values.

## Rule the api enforces with this data

A partner signature may only be shown with results from **its own PDF**: look it up by
`(orgId, sourceSha256, sha)` where `sourceSha256` is the report's `ReportProvenance.sourceSha256`. Never
look a signature up by `sha` alone for printing.

## Migration

New tables and collections only; nothing existing changes. `repos.sync()` (`createDb({ sync: true })`,
or the api's `npm run db:sync`) creates them and their indexes on PostgreSQL and MongoDB.
