# Patient links

The QR on a report or a bill opens a read-only page for that one booking: its bill and its released
reports. The api owns the logic (tokens, expiry, rate limits, what the page shows); db-kit only stores
the links, on both backends.

| Repository | Table / collection | Unique | Holds |
|---|---|---|---|
| `patientLinks` | `patient_links` | `tokenHash` | organisation, branch, booking, patient, `tokenHash` (SHA-256 hex of the token), `nonce`, `expiresAt`, `revokedAt` / `revokedBy`, `createdBy`, `lastViewedAt`, `viewCount` |

Rules:

1. **The token is never stored.** Look links up by `tokenHash` only. The api derives the token as an HMAC of
   `nonce` with its own secret, so it can print the same link again; the nonce alone is useless.
2. A link is for one booking. Listing a booking's links uses `(orgId, bookingId)`.
3. Revoking sets `revokedAt`; rows are kept for audit. Expiry is checked by the api (`expiresAt`).
4. Never log tokens, nonces or the pages they open.
