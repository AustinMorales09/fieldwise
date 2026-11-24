# 21 · Fieldwise: document extraction

**Live demo:** https://fieldwise-demo.vercel.app/demo (signs you in to a shared demo account that resets itself)

For bookkeepers, accounts-payable clerks and ops teams who retype invoices, receipts and forms. You define a template (the fields you want) and upload PDFs, photos or text. Each value is shown next to the original document with the text it came from. Deterministic checks then flag what looks wrong, and only approved documents are exported.

## Run

```bash
npm install
npm run dev
```

Open http://localhost:3021, sign up (you get Invoice and Receipt templates), and click **Load 4 sample documents**.

**To use Claude**, set `ANTHROPIC_API_KEY` before starting the server. Without credentials the app uses label matching, which reads text files and simple text-based PDFs. Photos and scans are parked as "Needs AI".

| Variable | Effect |
|---|---|
| `ANTHROPIC_API_KEY` | Enables Claude (reads PDFs, scans and photos) |
| `EXTRACT_AI=off` | Forces label matching |

## Templates (`lib/fields.ts`)

A template is a list of fields, one per line: `Label | type | flags | hint`.

- **Types:** `text`, `number`, `money`, `date`, `yesno`.
- **Flags:** `required` blocks approval while the field is empty. `id` marks what identifies the document, and is used to spot duplicates.
- **Hint:** tells the extraction which of several similar values you mean ("the company that issued the invoice, not the customer").
- **Optional table:** e.g. line items, with its own columns.

## How extraction works

**With Claude** (`lib/claude.ts`): one streamed structured-output call per document, using the official `@anthropic-ai/sdk`, model `claude-opus-5-5`.

- **Native document input:** PDFs go as `document` blocks and images as `image` blocks (base64). Text files go as text inside `<document>` tags.
- **Schema built from the template:** every field returns `{ value, confidence, evidence }`, typed by the field's type, plus the table rows. The model can't return a field you didn't define.
- **No guessing or computing:** absent fields are null. The prompt forbids adding up line items to invent a missing total, because that would hide the very error the checks exist to catch.
- **Untrusted input:** instructions inside a document are never followed.
- **Other settings:** a static, cached system prompt; `fallbacks: "default"` for safety refusals; streaming for long tables.
- **Failures are visible:** a refusal or cut-off falls back to label matching when the document has text. Otherwise the document is marked **Failed**, never silently empty.

**Without Claude:**

- `lib/rules.ts` finds values next to recognizable labels ("Invoice number: …", "Total: …"). Labels match whole words only, so "PO" isn't found inside "Poster". It also reads `description qty price amount` rows. A vendor taken from the first line is a guess and is marked low confidence.
- `lib/pdftext.ts` is a deliberately small PDF text reader. It inflates content streams and reads the text operators. It handles simple text-based PDFs and returns nothing for scans or custom-encoded fonts, which then show as **Needs AI**.

**Always, on both paths** (`lib/process.ts`, `lib/fields.ts`):

- **Normalization:** dates in many written forms become `YYYY-MM-DD`. Money like `$1,234.50`, `1.234,50 €` or `(45.00)` becomes a number.
- **Evidence check:** when the document's text is available, each quoted snippet is checked against it. One that isn't there is flagged.
- **Checks that don't rely on the model:**
  - required fields
  - subtotal + tax = total
  - line items add up
  - quantity × unit price = amount per row
  - due date before document date
  - implausible dates
  - low confidence
  - possible duplicates (same `id` fields as another document)
- **Real file types:** the type is taken from the file's own bytes, never the browser's claim. An `.exe` labelled as a PDF is refused.

## Review and export

- **Side by side:** the original (PDF viewer, image or text) sits next to editable fields, each with its confidence and source snippet.
- **Re-check on save:** editing a value re-runs the checks and marks the field "entered by you", since the model's confidence no longer applies.
- **Approve** is blocked while a required field is empty. Warnings can be approved knowingly. After approving, you land on the next document waiting.
- **Export:** CSV per template (one row per document), plus a second CSV of table rows keyed by the document's id field. Only approved documents are exported, and cells are safe against spreadsheet formula injection.

## Privacy

With Claude on, uploaded documents are sent to Anthropic's API to be read. The Settings page says so.

## Verified

- **Unit tests** (12 checks):
  - **Template editor:** parsing, aliases, errors, round trip.
  - **Normalization:** dates and money in many written forms.
  - **Checks:** every check, plus a clean pass.
  - **Label matching:** including whole-word labels.
  - **PDF reader:** plain, compressed and kerned text; noise and non-PDFs return nothing.
  - **Processing without AI:** a text file, a PDF, and a photo that goes to "Needs AI".
  - **Duplicates:** flagged.
  - **Claude path, mocked client:** a PDF sent as a base64 document block, an image as an image block, the schema keys matching the template, and an evidence snippet verified or flagged. A refusal on a photo ends as Failed.
  - **Real SDK with no credentials:** it's detected and label matching is used.
  - Run them with `npm test` (`scripts/test.mjs` copies `lib/` with explicit `.ts` imports into a scratch folder and runs every file in `tests/` against a throwaway database).

- **Browser, end to end, in label-matching mode** (no API key on the build machine):
  - **Samples:** four sample documents extracted.
  - **Review flow:**
    - The planted error was flagged ("Subtotal 165.00 + tax 13.20 = 178.20, but the total says 187.20"). Correcting it cleared the check.
    - Approving moved to the next document.
    - Approving with an empty required field was blocked.
    - The re-sent invoice was flagged as a duplicate, then rejected.
  - **Uploads:** a real PDF was read and rendered beside its fields. A PNG went to "Needs AI". An `.exe` claiming to be a PDF was skipped.
  - **Template editor:** it gave a line-specific error for a bad type, then saved a new template with a table.
  - **Exports:** both CSVs contain only the approved documents, with the corrected total.
  - **Access:** without login, pages redirect, files return 404 and exports 401.
  - **Checks:** no horizontal scroll at phone width, no console or server errors, and `next build` passes.
- **Not verified:** a live Claude call, and therefore reading of real scans and photos. The request typechecks against the installed SDK (1.8.0) and is exercised with a mocked client, but no real API request was made. The first run with a real key should be watched.

## Integrations: QuickBooks Online and Excel

Approved documents are sent on their own; nothing leaves Fieldwise before a person approves it. **Integrations** in the nav connects them, live or with the simulator.

- **QuickBooks Online** (`lib/integrations/quickbooks.ts`): an approved invoice becomes a **Bill**.
  - **Vendor:** found by exact display name, or created.
  - **Lines:** line items are used when they add up to the approved total, with tax as its own line. Otherwise the bill gets one line for the total, so QuickBooks never disagrees with what the reviewer approved.
  - **Duplicates:** before creating, it looks for a bill with the same vendor and invoice number and links that one instead. The create itself carries Intuit's `requestid`, so a retry after a timeout can't make two bills.
  - **Corrections:** a correction after approval updates the same bill, using the current `SyncToken`; a stale-object error is re-read and retried once.
  - **Setup:** you choose the expense account and which templates are sent. Refresh tokens rotate on every refresh and are saved each time.
- **Excel on OneDrive** (`lib/integrations/excel.ts`, Microsoft Graph, OAuth with PKCE): on first connect, Fieldwise uploads `Fieldwise/Fieldwise exports.xlsx`. Each template gets a worksheet with an Excel table, created when its first document is sent.
  - **Finding the row:** each send looks up the document's row by document number (people sort and filter sheets, so positions aren't trusted) and updates it, or appends a row.
  - **No duplicates:** a retried append finds its own row instead of adding a second one.
  - **Formula injection:** text that Excel would run as a formula is prefixed with an apostrophe.
- **.xlsx download, no account needed:** every template's approved documents also download as `.xlsx` from the Documents page. `lib/integrations/xlsx.ts` writes Office Open XML directly: numeric cells, a bold frozen header, and strings that can never run as formulas.
- **Per-document status:** each document shows where it was sent ("Bill 142 updated · row 3 on Invoice updated"). The Integrations page lists recent jobs and the log, and in simulator mode shows what the simulated company or workbook now holds.

| Env var | Effect |
|---|---|
| `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET` | Live QuickBooks connection (an Intuit developer app; redirect URI `<APP_URL>/integrations/quickbooks/callback`). |
| `QBO_ENV` | `production` for real companies; anything else uses Intuit's sandbox companies. |
| `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_TENANT` | Live Excel connection (an Entra app with `Files.ReadWrite` and `offline_access`; tenant defaults to `common`). |
| `INTEGRATIONS_KEY` | Key for sealing stored credentials (otherwise a key file is created in the data folder). |
| `APP_URL` | Public base URL for OAuth redirect URIs. |

### How the integration layer works (`lib/integrations/core.ts`)

The same small core sits under every provider:

- **Credentials sealed at rest.** Tokens and API secrets are stored with AES-256-GCM, keyed by `INTEGRATIONS_KEY` (or a random key file next to the database). Disconnecting deletes them.
- **OAuth done properly.** The state parameter is single-use, expires after 10 minutes and is bound to the person who started the flow. PKCE is used where the provider supports it.
- **Token refresh.** Tokens refresh shortly before they expire, and once more on a 401. Parallel callers share a single refresh, because providers that rotate refresh tokens lock you out if two refreshes race.
- **Retries that can't duplicate.** A 429 waits for `Retry-After`, and other 5xx errors back off. A POST is retried only when it is idempotent (an idempotency key, upsert or client-chosen id) or when the server said 429. Bad data fails right away with the reason instead of retrying.
- **An outbox.** Work is queued in `integration_jobs`, keyed so the same work collapses into one job, and runs after the response has been sent (Next.js `after`). Pages never wait on a third-party API. Failed jobs show their error and can be retried.
- **Links.** `integration_links` records which remote record each local record became, plus a hash of the values last synced. That is what makes re-syncs no-ops and lets two-way sync tell who changed what.
- **A built-in simulator for every provider** (`lib/integrations/sim-*.ts`). "Try it with the simulator" connects without an account. The integration code is identical in both modes; only the fetch function differs. Each simulator speaks the provider's request and response shapes, validation and error codes. Every 6th call gets a 429 so the retry path runs for real, and "Expire the access token" exercises refresh-on-401.

**Verified** (`npm test` runs `tests/integrations.mjs`, 14 checks, all against the simulators):
- **Core:** sealing and tamper detection; retry rules (429 with `Retry-After`, 503, no blind POST retry); one shared refresh for parallel callers; a revoked token leads to "reconnect"; OAuth state is single-use and bound to its owner.
- **QuickBooks:** bill mapping; connect → company and accounts → vendor and bill; a correction updates the same bill (SyncToken 0 → 1) and an unchanged one is a no-op; an existing bill is linked, not duplicated; an expired token is refreshed and the refresh token rotates; a bad document fails once, with the reason, without marking the connection broken.
- **Excel:** formula defusing; row lookup after sorting; workbook and table creation; update in place; a lost link doesn't duplicate the row.
- **.xlsx:** a valid zip with matching CRCs. Opened in desktop Excel: two sheets, a bold header, numbers stored as numbers, and `=HYPERLINK(...)` left as plain text.
- **In the browser, simulator mode:** connected both. Sent two approved invoices, which became two bills (vendors created, line items and tax) and two rows. Corrected one invoice's tax and total and re-approved it: the same bill moved to SyncToken 1 and the same row was updated.

**Not verified:** calls to the real Intuit and Microsoft APIs, because no developer accounts were connected. The requests follow the documented endpoints and shapes (QuickBooks v3 with minorversion 75, Graph v1.0 workbook APIs), but a first live run should be watched, especially worksheet and table creation in Graph.

## Stack

Next.js 16 · `node:sqlite` · `@anthropic-ai/sdk` + `zod` · QuickBooks Online and Microsoft Graph over plain `fetch` · local file storage · plain CSS.

## Next steps toward a paid product

- A background queue with the Message Batches API for bulk uploads (extraction currently runs inline during upload)
- Email-in (forward invoices to an address), plus webhook/API output and a Xero push alongside QuickBooks
- QuickBooks: receipts as Purchases (expenses) and class/location tracking
- Click-to-highlight: show where on the page each value was read
- Per-template accuracy from reviewer corrections, and auto-approval for document types that are consistently clean
- Multi-page splitting (one PDF holding several invoices) and vendor-specific hints learned from corrections
