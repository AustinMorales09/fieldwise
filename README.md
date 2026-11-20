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
  - Run them from this folder; the copy step adds `.ts` to the relative imports:

```bash
mkdir -p .unit/lib && for f in db fields pdftext rules claude process time; do sed -E 's#from "\./([a-z-]+)"#from "./\1.ts"#g' lib/$f.ts > .unit/lib/$f.ts; done && (cd .unit && DATA_DIR="$PWD/data" node run.mjs); rm -rf .unit/lib .unit/data
```

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

## Stack

Next.js 16 · `node:sqlite` · `@anthropic-ai/sdk` + `zod` · local file storage · plain CSS.

## Next steps toward a paid product

- A background queue with the Message Batches API for bulk uploads (extraction currently runs inline during upload)
- Email-in (forward invoices to an address), plus webhook/API output and QuickBooks / Xero push
- Click-to-highlight: show where on the page each value was read
- Per-template accuracy from reviewer corrections, and auto-approval for document types that are consistently clean
- Multi-page splitting (one PDF holding several invoices) and vendor-specific hints learned from corrections
