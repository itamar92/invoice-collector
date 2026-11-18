# Morning (Green Invoice) API: what Task 12 relies on

R6: this was researched from public material only. The implementer made no calls to Morning.
"confirmed (source)" = read in Morning's own working code/docs; "from community schema" = read in a third-party wrapper, not verified against Morning docs; "assumed" = inferred.

Official reference: https://developers.morning.co/api (JS-rendered, its expense section could not be
read by the fetcher). The endpoint list below comes from the community wrapper
`@accounter/green-invoice-graphql@0.8.6` (`src/mesh-artifacts/sources/GreenInvoice/schema.graphql`,
generated from Morning's swagger), plus the working read code in
`account-manager/app/server/morningClient.ts`.

## Auth and base URL
- Base `https://api.greeninvoice.co.il/api/v1`; sandbox `https://sandbox.d.greeninvoice.co.il/api/v1`. confirmed (morningClient.ts; sandbox host from the task brief, unverified).
- `POST /account/token` body `{id, secret}` returns `{token, expires}` (unix seconds). Header `Authorization: Bearer <token>`. confirmed (morningClient.ts, working in production).
- Token cache until 30 s before expiry; 1 hour validity. confirmed (morningClient.ts; developers.morning.co landing page says 1-hour token).

## Expense endpoints
| Purpose | Endpoint | Status |
|---|---|---|
| Upload a file, creating an expense DRAFT | `POST /expenses/file` body `{file: "<base64>"}` (types GIF, PNG, JPG, SVG, PDF) | from community schema (`addExpenseDraftByFile`), not verified against Morning docs. Whether `file` must be a bare base64 string or a `data:` URI: the wrapper's consumer (Accounter) sends `data:<mime>;base64,<b64>`; we send that form. assumed |
| Draft response | `{id, status, creationDate, lastUpdateDate, expense: ExpensePartial, thumbnail, url}`; `status` enum `10` or `50` | from community schema, not verified against Morning docs. Meaning of 10 vs 50: NOT confirmed. |
| Search drafts | `POST /expenses/drafts/search` body `{fromDate?, toDate?, description?, supplierId?, supplierName?, page?, pageSize?}` (dates YYYY-MM-DD, by creation date); response `{total,page,pageSize,pages,items:[{id,status,creationDate,expense:{number,date,amount,vat,supplier,fileKey,fileHash,...}}]}`; 404 body `{errorCode, errorMessage}` | from community schema, not verified against Morning docs |
| Create a real expense | `POST /expenses` | exists per community schema (`addExpense`), not verified against Morning docs. NOT USED: a created expense is not a draft, so it would skip approval (violates "never create an already-approved expense"). |
| Update expense | `PUT /expenses/{id}` | exists per community schema, not verified against Morning docs. NOT USED: not confirmed it can fill a draft without confirming it. |

Pending approval: drafts (`/expenses/file`) are by name "drafts" and appear in Morning's expense inbox until confirmed
(assumed). The status value that means "pending approval" is NOT confirmed (10 and 50 are the only values the schema lists).
The code therefore never inspects it and never calls anything that confirms a draft.

Never called: any endpoint with `approve` or `report` in its path; no draft-confirm endpoint was found, none is used.

## Consequences for the three modes
- **api_file**: implemented on `POST /expenses/file`. Morning reads the PDF itself.
- **api_fields**: NOT confirmed. No documented way to attach our extracted fields to a draft without confirming it
  (`POST /expenses` creates a final expense; `PUT /expenses/{id}` on a draft is unverified). `detectMorningModes().api_fields`
  is always `false`. If a user's settings still say `api_fields`, `send` uploads the file only and reports mode `api_file`.
  Revisit at go-live with a sandbox account: try `PUT /expenses/{draftId}` and check the draft stays a draft.
- **email**: mailer sends the PDF to `settings.morning.inboxEmail`; ref = the mailer's returned id (Gmail message id).

## detect (read-only probe, unit-tested with injected fetch only)
`api_file` is true iff authentication succeeds and `POST /expenses/drafts/search` with `{page:1,pageSize:1}` returns 2xx.
This only proves the drafts API is reachable on the account, not that upload works (unverifiable without writing).

## Retry safety (R16)
Only a retry looks for an earlier upload: the pipeline passes `retry: true` when this item already had a send attempt
(a transient failure counted in `attempts`, or an `accounting_send_attempt` event left by a crash mid-send). A first send
never searches, because any draft it found would belong to another document (two vendors can share a number).
On a retry, search drafts created in the last 7 days (`fromDate` = today-7d) and reuse a draft only when it is provably
this document: `expense.number` equals our document number AND `expense.amount` equals our total AND the supplier
matches (`expense.supplier.taxId` digits equal our vendor tax id, or the normalized `expense.supplier.name` equals our
vendor name). Limits: these fields are filled by Morning's own OCR, possibly after a delay, and the supplier field
names come from the community schema. Residual duplicate risk: a timeout after Morning stored the draft but before the
response, retried before OCR filled number/amount/supplier (or with a supplier name that OCR spelled differently), or an
item with no document number or total, creates a second draft (the user sees and deletes it). This is preferred over
the opposite failure, silently skipping a different document that shares a number.
Email mode: no way to check an inbox for earlier sends; a timeout in the mailer after Gmail accepted the message can
send the same PDF twice.

## Not confirmed
- Meaning of draft `status` 10 / 50.
- `file` format (bare base64 vs data URI) and size limit.
- Whether `POST /expenses/file` rate-limits (429 is treated as transient anyway).
- Whether `PUT /expenses/{id}` can fill a draft while keeping it a draft.
- Sandbox availability for the expenses endpoints.

## Go-live checklist (sandbox account, `sandbox.d.greeninvoice.co.il`)
- `file` field format: data URI vs bare base64.
- Which draft `status` values mean pending approval (10 vs 50).
- That `POST /expenses/file` creates a pending draft, not a confirmed expense.
- Whether `PUT /expenses/{id}` on a draft keeps it pending (required before api_fields can be enabled).
- That `POST /expenses/drafts/search` is a harmless read (detect relies on it).
