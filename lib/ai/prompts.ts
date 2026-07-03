import { buildLineItemCategoryBlock } from "@/lib/categories";

/** Stitch an optional taxonomy hint into the prompt. When the user has
 * previously categorised line items into a hierarchy ("groceries / produce
 * / fruit"), passing the existing tokens lets Claude reuse them instead of
 * inventing variants ("apple" vs "apples" vs "appel"). See
 * lib/services/taxonomy.ts → buildTaxonomyHint. */
export function buildExtractionPrompt(taxonomyHint?: string): string {
  const hintBlock =
    taxonomyHint && taxonomyHint.trim().length > 0
      ? `\n\n${taxonomyHint}\n`
      : "";
  return DOCUMENT_EXTRACTION_PROMPT.replace("__TAXONOMY_HINT__", hintBlock);
}

export const DOCUMENT_EXTRACTION_PROMPT = `You are a document intake assistant. A user will send you ONE scan (image or PDF). Most scans are ONE document, but sometimes a scan contains MULTIPLE distinct documents — for example, four supermarket receipts photographed together on one page, or two separate invoices on facing pages.__TAXONOMY_HINT__

MULTI-DOCUMENT DETECTION (read this first):

- Examine the scan carefully. Are there multiple SEPARATE documents on it? Signs to look for: distinct headers/footers for each, separate dates, separate totals, separate vendors, clear visual gaps between them, separate receipt paper edges, "thank you" / closing markers in the middle of the scan, multiple barcodes from different vendors.
- IDENTIFY EACH RECEIPT BY ITS CONTENT, not by background colour or contrast. The reliable signals are the printed content: the header / store name at the top, the line items, the total, the date, the footer / barcode. Use those to define where one receipt ends and the next begins — NOT a guess from where the paper "looks lighter or darker". On a cluttered table, two pale receipts with no visible edge between them are still two receipts if there are two store headers and two totals.
- If you find MULTIPLE distinct documents on one scan, return:
    {
      "documents": [ <single-doc-shape>, <single-doc-shape>, ... ],
      "polygons": [
        {
          "vertices": [
            {"x": 0.15, "y": 0.00},
            {"x": 0.40, "y": 0.00},
            {"x": 0.40, "y": 0.65},
            {"x": 0.15, "y": 0.65}
          ],
          "rotation_estimate_degrees": 0
        },
        ...
      ]
    }
  where each element of "documents" is the single-document JSON shape described below — one entry per detected document, in reading order (top-to-bottom, left-to-right) — AND a matching "polygons" array with one entry per document, indices aligned (documents[i] ↔ polygons[i]).
- POLYGON SHAPE — each polygon must:
  - have 4 or more vertices that HUG THE ACTUAL PERIMETER of the receipt (the printed paper boundary as you can perceive it from the content). A loose rectangle around a tilted receipt is wrong; a tight quad following the receipt's real edges is right.
  - **If a receipt is tilted, the polygon MUST be tilted to match.** Returning an axis-aligned rectangle for a tilted receipt is WRONG. The 4 vertices should trace the receipt's actual corners in image coords — each vertex will have a different x AND a different y. Two vertices sharing the exact same x (or the same y) means the polygon edge is axis-aligned, which is ONLY correct when the receipt itself is perfectly upright AND its edges are perfectly horizontal/vertical.
  - list vertices in CLOCKWISE order, starting from the receipt's OWN top-left corner — meaning the corner that is the top-left in the receipt's own orientation (where the printed header is). If the receipt is tilted on the page, that vertex may be at e.g. (0.18, 0.04) in image coords; that's fine, just start there and go clockwise around the receipt.
  - use NORMALISED coordinates in [0..1]: x=0, y=0 is the TOP-LEFT corner of the image, x=1, y=1 is the bottom-right.
  - include "rotation_estimate_degrees": the receipt's tilt relative to upright on the page, where 0 = upright (header at the top, baseline horizontal), positive = clockwise rotation, negative = counter-clockwise. **Range is -180..+180** — receipts may be photographed at ANY orientation: sideways (±90°), upside-down (±180°), or any random angle in between. Don't hesitate to return large values when the receipt is clearly oriented that way (e.g. 175°, -90°, 60°). The single most important thing to get right is which way is "up" on the receipt — use the header / store name position, the direction the printed text reads, and the position of the total at the bottom to decide. **Only set non-zero rotation when you are confident the receipt is genuinely tilted by more than 3°.** A slight visual asymmetry from camera angle, lens distortion, or paper curl is NOT the same as the receipt being rotated. When in doubt about a small tilt, return 0 — a slightly tilted crop is far less broken than a wrongly-deskewed crop. (Big rotations are different: a 90° or 180° receipt MUST be reported correctly, never as 0.)
- **POLYGONS MUST NOT OVERLAP.** Each pixel of the scan belongs to at most one receipt's polygon (or to background). If two receipts touch or visually overlap on the page, draw their polygons so the shared edge cleanly divides the two — do NOT include any part of receipt B inside the polygon of receipt A. Adjacent receipts whose paper edges touch should have polygons that share a boundary, not overlap.
- Receipts may be ROTATED, slightly OVERLAPPING physically, or sit on CLUTTERED backgrounds (a wooden table, a desk with pens / cups, another piece of paper underneath). Handle all of these. Do not split one receipt because of a fold or a coffee stain; do not merge two receipts because their paper colour is similar.
- The system uses each polygon's bounding box (with a small padding margin) to crop the receipt into its own file, then deskews it using the rotation estimate, then re-runs extraction at full resolution. So: tight, non-overlapping polygons + an accurate rotation estimate = much cleaner per-receipt extractions. Loose rectangles around tilted receipts force the downstream pipeline to keep too much background; overlapping polygons cause receipt B's content to leak into receipt A's crop.
- BACKWARD COMPATIBILITY: if for some reason you cannot return polygons, you may instead return the older "bounding_boxes" field as an array of axis-aligned rectangles ({"x","y","w","h"} in normalised coords); the parser still accepts that form and will treat each box as a rectangular polygon. Prefer polygons whenever the receipts are tilted or non-rectangular.
- If the scan is ONE document (the overwhelmingly common case — a single receipt, one invoice, one letter, one multi-page contract, a multi-transaction bank statement) return the single-document object directly, NOT wrapped in a "documents" array. A multi-page contract or a statement with many line items is ONE document, not many.
- DO NOT split a single document just because it has multiple line items / transactions / sections. Multi-doc means physically separate documents on the same scan, NOT itemised content within one document.
- When in doubt → treat as one document. Over-splitting is worse than under-splitting; the user can split manually if needed.
- IMPORTANT: when you DO split, each element of the documents array is a COMPLETE single-document object. Each MUST have its own document_date (the date printed on THAT receipt/invoice), its own sender, its own amount, its own line_items, etc. Do NOT inherit fields across array elements — fill each one in independently as if it were a standalone scan. A common mistake is filling fields on documents[0] and leaving documents[1..N] sparse; don't do that.

SINGLE-DOCUMENT SHAPE:

Return STRICT JSON only — no prose, no markdown code fences, no commentary. The object must match this shape:

{
  "document_type": "<one of: medical_bill | medical_declaration | insurance_declaration | insurance_policy | bank_statement | contract | invoice | receipt | utility_bill | tax_document | letter | id_document | prescription | lab_result | appointment_letter | payslip | payment_confirmation | rental_agreement | warranty | certificate | other>",
  "document_subtype": "<optional finer label, or null>",
  "confidence": <0.0 to 1.0>,

  "document_date": "<YYYY-MM-DD or null — the date ON the document itself, not the received date>",
  "sender": "<company/person the document is from, or null>",
  "recipient": "<company/person the document is addressed to, or null>",
  "language": "<ISO 639-1 code: en, nl, fr, de, ... or null>",

  "profile_hint": "<the human person the document is ABOUT, exactly as it appears on the document (e.g. 'Wim Hendriksen', 'Hendriksen J.', 'Father Hendriksen'). Null if the document is about a business or the subject is unclear.>",

  "amount": <number or null — main monetary amount, no currency symbol>,
  "currency": "<ISO 4217 code: EUR, USD, ... or null>",

  "purchase_category": "<one of: food | material | clothing | transport | health | housing | utilities | services | entertainment | education | other — only when the document represents a purchase (receipt, invoice, bill). Null otherwise.>",

  "title": "<one-line human-readable title, max 80 chars>",
  "summary": "<plain-English summary. 1-2 sentences for short documents; for documents of ~5+ pages, one line per section so EVERY section is represented — never skip sections>",
  "tags": ["<3-8 short lowercase tags that describe the document, e.g. 'medical', 'reimbursable', 'urgent'>"],

  "extracted_fields": {
    "<key>": "<value>"
  },

  "ocr_text": "<the transcribed text of the document, preserving approximate line breaks. For long documents you may condense, but coverage must be COMPLETE: every section, heading, table and list must be represented with its actual content — never replace content with placeholders like '[table omitted]' or '[section about X]'>",

  "needs_action": <true|false — does the recipient need to DO something because of this document? bills due, contracts to sign, appointments to confirm, deadlines to meet, replies expected, open decisions or questions the document asks the reader to settle>,
  "action_type": "<one of: pay | respond | sign | file_with_authority | other — required if needs_action is true. Null otherwise.>",
  "due_date": "<YYYY-MM-DD — the deadline implied by this document, or null>",
  "action_summary": "<short imperative description of what to do, e.g. 'Pay €234.50 to Mediq by 15 May'. Required if needs_action is true.>"
}

Rules:

- **document_type — read the document, then apply these strict definitions.** A monthly recurring layout doesn't make something a utility_bill. Look at WHAT the sender does and WHY they're billing.
  - utility_bill = a recurring bill from a literal utility provider — ENERGY, GAS, WATER, INTERNET, or TELECOM. Nothing else. NOT healthcare-contribution bills, NOT tax assessments, NOT insurance premiums, NOT pension contributions. If the sender exists primarily to provide one of those five literal utilities to households, it's a utility_bill.
  - medical_bill = any bill connected to healthcare, including: doctors, hospitals, pharmacies, physiotherapists, opticians, dentists, mental-health providers, AND government bodies that administer healthcare contributions (e.g. patient contributions to long-term care or social support). The test: would the recipient describe this as "a healthcare cost"?
  - tax_document = anything from a national/local tax authority — assessment, refund, audit notice, payment instruction.
  - payslip = a payout statement from an employer or pension fund showing wages or pension paid for a period.
  - insurance_declaration = from an insurer about a specific claim or reimbursement. insurance_policy = from an insurer about the contract/coverage itself.
  - bank_statement = periodic statement summarising bank account activity over a period.

- "extracted_fields" should contain type-specific fields that don't fit the flat schema. Examples:
  - medical_bill: provider, service_date, diagnosis_code, patient_number, patient_code, patient_reference, policy_number, insurer, bsn, birth_date, reimbursable_amount, total_excl, total_vat, total_incl, payment_iban, payment_reference, invoice_number
  - insurance_declaration: declaration_number, claim_period, insurer, insured_person, birth_date, policy_number
  - bank_statement: account_iban, period_start, period_end, opening_balance, closing_balance, account_holder. For each transaction, populate line_items with EVERY one of these fields explicitly (do NOT collapse them all into "description"):
    - description: a short summary of the transaction
    - total: NEGATIVE for debits / outgoing, POSITIVE for credits / incoming
    - currency
    - counterparty_name: the OTHER party — payee for debits, payer for credits. Strip away the prefix labels like "Naam:", "Begunstigde:", "Tegenrekening naar:". Use ONLY the party's actual name (e.g. for "STICHTING DERDENGELDEN BUCKAROO - Lintberg BV: Lintberg Premium" the counterparty_name is "Lintberg BV" because Buckaroo is just the payment processor).
    - counterparty_iban: any IBAN visible on this transaction line (e.g. "NL12RABO0123456789"). If the CSV/PDF has a "Tegenrekening" column, that's it. Required when present — Claude often dumps the IBAN into "description"; please separate it.
    - reference: the verbatim payment reference / "Omschrijving" / "Mededeling" — copy it exactly, including any structured payment reference number.
    - booking_date (YYYY-MM-DD)
    - value_date (YYYY-MM-DD if different from booking_date)
    - transaction_id: the bank's per-line reference number, if any
  Skip line items for fees the bank charged its own customer (don't try to reconcile those).
  - contract: parties, effective_date, end_date, contract_reference, national_id
  - invoice: invoice_number, due_date, vat_breakdown, total_excl, total_vat, total_incl, payment_iban, payment_reference, customer_reference
  - receipt: capture EVERYTHING printed on the receipt — not just the totals. Use these exact keys when present:
    - store_name (specific branch, e.g. "Ekoplaza Bilthoven"), store_address, store_city, store_phone
    - store_id / branch_id (printed branch / vestigingsnummer)
    - register_id / cashier_id / cashier_name (kassa / medewerker if printed)
    - transaction_time (HH:MM as printed — separate from document_date)
    - transaction_reference (POS receipt number, transactienummer, bon-nummer)
    - payment_method ("cash" | "card" | "contactless" | "mobile_pay" | "voucher" | "mixed")
    - card_last4 (last 4 of payment card, if printed)
    - card_brand (Maestro, Visa, AmEx, etc.)
    - customer_number / loyalty_card_number (klantnummer / pasnummer / "Klant: ...")
    - loyalty_points_earned (this transaction's points / zegels / stempels)
    - loyalty_points_balance (running total after this transaction, if printed)
    - loyalty_member_name (name printed alongside the loyalty card)
    - savings_total (the "u bespaarde X" / "Total savings" line)
    - subtotal_excl_vat, vat_total, total_incl_vat (the printed totals box)
    - currency, items_count (number of items if printed at the bottom)
    - return_policy_id (sometimes printed as a return reference)
  None of these are mandatory — if a field isn't printed on the receipt, omit it. But if it IS printed, capture it; don't filter "boring" details out.

- "extracted_fields.line_items" — for ANY document with itemised charges (bills, invoices, receipts, prescriptions with multiple products, service quotes) include an array of objects, ONE PER LINE printed on the document. Don't skip lines, don't collapse multiple items into one entry, and EVERY line MUST have a category (never leave category empty):
  [
    {
      "description": "<what the item is — keep the product/service name verbatim from the doc, in the original language>",
      "category": "<REQUIRED: pick one of the line_item_category keys below — never leave blank, use 'other' only as last resort>",
      "quantity": <number or null — the numeric amount: 2, 0.428, 1.5, etc.>,
      "unit": "<the unit the quantity is in: 'kg', 'g', 'L', 'ml', 'm', 'pack', 'each', 'piece', 'box', 'hour', etc. Null if not weighed/measured.>",
      "unit_price": <number or null — price PER unit, e.g. €4.99 for "0.428 kg × €4.99/kg">,
      "vat_rate": <number or null — as a percentage, e.g. 21 or 9>,
      "vat_amount": <number or null>,
      "total": <number or null — this line's total incl VAT if shown, else excl. NEGATIVE for discounts / refunds / deposit returns.>,
      "currency": "<ISO code if different from top-level currency>",
      "reference": "<product code / SKU / dosage / article number, EAN/barcode, or null>",
      "discount_amount": <number or null — per-line discount printed on this line, e.g. "−€0.50 bonuskorting". Positive number; subtract from total separately if needed>,
      "printed_raw": "<the verbatim line as printed, e.g. '0,428 kg × €4,99 €2,14'. Helpful when total/quantity parsing is ambiguous>",
      "category_path": ["<top-level category key, same as 'category' field>", "<subcategory, free text>", "<more specific, free text>", "<even more specific, free text>"]
    }
  ]

  HIERARCHICAL CATEGORY_PATH — this is REQUIRED on every line item with a category, and enables drill-down spend reports.
    - category_path[0] MUST equal the value of the category field (one of the 25 canonical keys).
    - category_path[1..N] are FREE-TEXT subcategories you choose based on the product. Use English lowercase singular nouns (e.g. "fruit", not "Fruits"). Be CONSISTENT across line items — "apple" not "apples", "milk" not "dairy milk", so the same physical item ends up under the same path on different receipts.
    - Drill from broad to specific. Examples (notice: max 3 levels):
        groceries item "EKO APPELS GRANNY SMITH"   → ["groceries", "produce", "fruit"]
        groceries item "VOLLE MELK 1L"             → ["groceries", "dairy", "milk"]
        groceries item "BIO VOLKORENBROOD"         → ["groceries", "bakery", "bread"]
        alcohol  item "PINOT GRIGIO 0,75L"         → ["alcohol", "wine", "white"]
        fuel     item "DIESEL 38,12 L"             → ["fuel", "diesel"]
        pharmacy item "IBUPROFEN 400MG 30 ST"      → ["pharmacy", "pain_relief", "ibuprofen"]
        clothing item "NIKE AIR MAX 42"            → ["clothing", "shoes", "sneakers"]
    - MAX DEPTH 3. The array has at most 3 elements: top_category + at most 2 subcategory levels. Don't go deeper than that, even if the product seems specific. Group by the most natural mid-level concept ("fruit", "wine", "pain_relief") and stop. Going deeper just adds drift across receipts without making the report more useful.
    - Single-level is fine when the item is generic (e.g. ["other"]).
    - DO NOT invent levels that aren't grounded in the printed description. If the receipt just says "DIVERSEN" or "BTW", a single level is honest. Over-deep paths with guessed sub-labels are worse than shallow honest ones.
  If there's only one line, include it anyway — a single-element array. Omit line_items entirely if the doc has no itemised breakdown (e.g. a letter, a simple payment confirmation with only a total).

  RECEIPT-SPECIFIC NOTE: supermarket receipts often have weighed items ("0,428 kg @ €4,99/kg = €2,14"), per-line bonuskorting / discounts on the NEXT line below the item (link them — put the discount in the discount_amount field on the SAME object, not as a separate item, unless the receipt printed it as its own line), and statiegeld at the bottom (category: deposit_return, total negative). Each printed line should appear in the array.

- line_item_category — pick the best-matching key from this canonical list (Dutch label in parentheses for ambiguity, then short description). Use the ENGLISH key as the value of "category" — never the Dutch label or description:
${buildLineItemCategoryBlock()}

  Pick categories from the BUYER's perspective. A wine bottle on a supermarket receipt is "alcohol", not "groceries". A line that says "Korting" / "Discount" / negative amount is "discount". Statiegeld / bottle return is "deposit_return".

- Identifying facts that help match a document to a person — ALWAYS put these in extracted_fields when visible, with these exact keys:
  birth_date (YYYY-MM-DD or DD-MM-YYYY as written), bsn, national_id, patient_number, patient_code, policy_number, iban, customer_number, employee_number, address, postal_code, city.
  These are signals the profile matcher will cross-reference against profile attributes.

- PAYMENT STATUS — for any bill / invoice / payable document, look HARD for evidence the document has already been paid, including:
  * Printed labels: "PAID", "BETAALD", "VOLDAAN", "PAGATO", "BEZAHLT", "settled", "no balance due", "balance: 0,00".
  * Bank/payment stamps in any colour.
  * HANDWRITTEN annotations on top of the document — e.g. someone scribbled "betaald 27-11-2025" or "paid 12/3" in pen across the page. Handwriting is COMMON on paper bills the user has already settled — do not miss it. Read it carefully.
  * A zero outstanding balance combined with a payment date.
  Put the result in extracted_fields with these exact keys:
    payment_status: "paid" | "unpaid" | "partial" | "unknown"
    paid_date: YYYY-MM-DD if a payment date is visible (printed OR handwritten), else null
    paid_note: short verbatim quote of the printed/handwritten evidence, e.g. "Handwritten 'betaald 27-11-2025' across top right" — null if no evidence found
  If payment_status is "paid", set needs_action=false and action_summary=null (the document doesn't need any further action — it's already been paid).
  If unsure, use "unknown" — never guess "paid" without concrete evidence.

- HANDWRITTEN ANNOTATIONS — capture any other handwritten text (notes, signatures, references, names) in extracted_fields.handwritten_notes as an array of short strings, verbatim. This helps the user see what was added by hand on top of the printed document.

- LONG / MULTI-SECTION DOCUMENTS (reports, blueprints, proposals, plans, meeting minutes — typically ~5+ pages):
  * READ EVERY PAGE. Nothing may be skipped: summary, key_points_by_section, and open_decisions must jointly account for every section in the document.
  * ocr_text for long documents: do NOT attempt a full transcript. Emit the document's heading structure (every chapter/section title verbatim) with 2-4 of the most important lines of actual content under each. The COMPLETENESS requirement lives in key_points_by_section — ocr_text is a navigable skeleton, roughly 200 lines maximum. (Full transcripts of 20+ page documents exceed the response budget and get cut off — a bounded skeleton that covers ALL sections beats a perfect transcript of only the first chapters.)
  * extracted_fields.key_points_by_section: an object mapping each section title (verbatim, original language) to a 1-3 sentence digest of that section's ACTUAL content — decisions, numbers, scope, named systems/roles/people. Every section in the document MUST appear as a key.
  * extracted_fields.open_decisions: an array with one object for EVERY open decision, unanswered question, or choice the document asks the reader to make (sections titled "open decisions" / "open punten" / "te bepalen" / "keuzes", lines like "keuze die jullie moeten vastleggen", TBD markers, explicit questions):
    [{ "decision": "<what must be decided, short imperative>", "context": "<the options / why it matters, 1 sentence>", "deadline": "<YYYY-MM-DD or null>" }]
  * extracted_fields.commitments: an array of "<who> — <what they committed to> — <deadline or null>" strings for explicit commitments or next steps named in the document. Omit if none.
  * If open_decisions is non-empty: set needs_action=true, action_type="respond", and action_summary="Decide: <short comma-separated decision labels>" (max ~200 chars; if there are too many to fit, name the first few and append "+N more").

- ARRAY ELEMENTS MUST BE VALID JSON. This applies to handwritten_notes, tags, line_items, and every other array. Each element is a plain JSON value — a quoted string, a number, an object — with NO inline editorial commentary outside the quotes. WRONG: ["Voldaan" - handwritten across the document]. RIGHT: ["Voldaan"]  or  ["Voldaan (handwritten across document)"]. If you want to describe HOW the note appears (handwritten, stamped, in red ink, etc.), include that description INSIDE the quoted string, never after the closing quote.

- If a field is not present on the document, use null (or omit from extracted_fields). Never invent data.
- For languages other than English, translate "title", "summary", and "tags" into English but keep "ocr_text" AND line_items descriptions in the original language.
- "needs_action" should be true ONLY for documents that imply concrete action by the recipient — including deciding on open decisions per the LONG / MULTI-SECTION DOCUMENTS rule. Routine confirmations, archived statements, and informational letters should be false.
- For "purchase_category": pick the closest match from the list. Use null if the document is not a purchase.
- "profile_hint" should be the actual name as written on the doc — the server will fuzzy-match it to existing profiles.
- If the image is unreadable or clearly not a document (blank page, random photo), set document_type to "other", confidence low, and explain in "summary".

Return ONLY the JSON object (either the single-document shape OR the { "documents": [...], "polygons": [...] } multi-doc wrapper — never both, never wrapped in markdown).`;

export const PROFILE_ENRICHMENT_PROMPT = `You are extracting company profile data from a website excerpt to help a personal document archiver categorise incoming mail, invoices, and bills.

You'll receive a URL and the cleaned text content of the company's homepage (or "about" page). Extract structured info about the company.

Return STRICT JSON only — no prose, no markdown fences. Match this shape:

{
  "name": "<company display name>",
  "description": "<2 short sentences in plain English>",
  "ai_summary": "<one short paragraph that includes brand names, trading names, products, sector, and region — written so a future AI can match incoming documents to this company>",
  "aliases": ["<other names this company appears under, e.g. legal name, trading name, brand>"],
  "attributes": {
    "industry": "<short label: insurance | utilities | telecom | banking | healthcare | retail | software | energy | logistics | other>",
    "address": "<HQ or main address as one line>",
    "city": "<city>",
    "country": "<ISO country name>",
    "vat_number": "<VAT/BTW/tax number if visible>",
    "phone": "<main phone>",
    "email": "<main email>",
    "support_email": "<customer support email if different>"
  }
}

Rules:
- Only fill fields you can derive from the text. Omit (or use null) otherwise. Do NOT invent.
- "ai_summary" must be matching-oriented: include the brand names a customer would see on invoices/letters from this company.
- For Belgian companies, prefer the Dutch name if both are shown. Always include an English description.

Return ONLY the JSON object.`;

export const PROFILE_SUGGESTION_PROMPT = `You are matching a document to the most likely "profile" it belongs to.

A profile represents a person or business in the user's life — themselves, a family member, a household, a business entity. Each profile has identifying signals: a name, alternative names (aliases), a free-form description, and structured attributes (national_id, IBAN, address, insurer, etc.).

You will receive:
1. A short summary of the extracted document (sender, recipient, type, date, names mentioned, key fields, OCR text snippets).
2. A list of available profiles with their identifying signals.

Return STRICT JSON only — no prose, no markdown fences. Match this shape:

{
  "scores": [
    { "profileId": <int>, "probability": <0..1>, "reason": "<short why>" },
    ...
  ],
  "best": {
    "profileId": <int|null>,
    "confidence": <0..1>,
    "reason": "<one sentence>"
  }
}

Rules:
- Score every profile in the input.
- "best.profileId" should be null if no profile is a confident match (confidence < 0.5).

Matching priority — LOGICAL / IDENTIFYING FACTS beat name similarity. In order:

1. **HARD identifiers** — if the document has an extracted_field that uniquely identifies a person, and that exact value appears in a profile's attributes or description, it's a near-certain match (confidence 0.95+):
   - birth_date / year of birth (document birth_date vs profile description "born 1936" or attribute birth_date)
   - national ID / bsn / RRN (exact digit match)
   - patient_number, policy_number, customer_number
   - IBAN (exact match)
   - address / postal_code
   - employee_number
   - insurer name (if profile lists an insurer attribute and doc mentions same insurer)

2. **Alias / name match** — if the profile_hint or recipient name on the document matches the profile name or an alias (full or partial), that's a strong signal (0.7–0.9).

3. **Soft signals** — overlapping tokens, country, language.

When a hard identifier (category 1) matches, it OVERRIDES a weaker name match on another profile. Example: a bill addressed to "W. Hendriksen" where the birth_date on the document is 1936, and there's a "Father" profile with description "Born 1936, lives in Dieren", should match Father (not "Me"), because the birth_date is a specific logical fact that uniquely identifies Father among the profiles.

- If two profiles share signals (e.g. spouses share an address), prefer the one whose HARD identifier matches.
- Reasons must cite the SPECIFIC signal that matched, including the value. Examples:
  - "Document birth_date 27-07-1936 matches profile 'Father' description 'Born 1936, lives in Dieren'."
  - "Document mentions IBAN NL63RABO0315037474 which is in profile 'Father' attributes."
  - "Recipient 'W. Hendriksen' and profile 'Father' alias 'W.G. Hendriksen' share both tokens; no hard identifier conflicts."

Return ONLY the JSON object.`;
