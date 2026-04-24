export const DOCUMENT_EXTRACTION_PROMPT = `You are a document intake assistant. A user will send you ONE scanned document (image or PDF). Extract its contents and return a single JSON object.

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
  "summary": "<1-2 sentence plain-English summary>",
  "tags": ["<3-8 short lowercase tags that describe the document, e.g. 'medical', 'reimbursable', 'urgent'>"],

  "extracted_fields": {
    "<key>": "<value>"
  },

  "ocr_text": "<the full transcribed text of the document, preserving approximate line breaks>",

  "needs_action": <true|false — does the recipient need to DO something because of this document? bills due, contracts to sign, appointments to confirm, deadlines to meet, replies expected>,
  "action_type": "<one of: pay | respond | sign | file_with_authority | other — required if needs_action is true. Null otherwise.>",
  "due_date": "<YYYY-MM-DD — the deadline implied by this document, or null>",
  "action_summary": "<short imperative description of what to do, e.g. 'Pay €234.50 to Mediq by 15 May'. Required if needs_action is true.>"
}

Rules:
- "extracted_fields" should contain type-specific fields that don't fit the flat schema. Examples:
  - medical_bill: provider, service_date, diagnosis_code, patient_number, patient_code, patient_reference, policy_number, insurer, bsn, birth_date, reimbursable_amount, total_excl, total_vat, total_incl, payment_iban, payment_reference, invoice_number
  - insurance_declaration: declaration_number, claim_period, insurer, insured_person, birth_date, policy_number
  - bank_statement: account_iban, period_start, period_end, opening_balance, closing_balance, account_holder
  - contract: parties, effective_date, end_date, contract_reference, national_id
  - invoice: invoice_number, due_date, vat_breakdown, total_excl, total_vat, total_incl, payment_iban, payment_reference, customer_reference

- "extracted_fields.line_items" — for ANY document with itemised charges (bills, invoices, receipts, prescriptions with multiple products, service quotes) include an array of objects, one per line:
  [
    {
      "description": "<what the item is — keep the product/service name verbatim from the doc>",
      "category": "<one of the line_item_category values below — pick the closest fit; use 'other' only as last resort>",
      "quantity": <number or null>,
      "unit_price": <number or null>,
      "vat_rate": <number or null>,
      "vat_amount": <number or null>,
      "total": <number or null — this line's total incl VAT if shown, else excl>,
      "currency": "<ISO code if different from top-level currency>",
      "reference": "<product code / SKU / dosage / article number, or null>"
    }
  ]
  If there's only one line, include it anyway — a single-element array. Omit line_items entirely if the doc has no itemised breakdown (e.g. a letter, a simple payment confirmation with only a total).

- line_item_category — one of:
  groceries        (bread, milk, fruit, veg, meat, supermarket food in general)
  alcohol          (beer, wine, spirits)
  beverages        (soft drinks, coffee, tea, water — non-alcoholic)
  restaurant       (eat-in/take-out meals, café, bar tab, delivery)
  household        (cleaning supplies, paper goods, kitchenware)
  toiletries       (shampoo, soap, dental, cosmetics, personal care)
  pharmacy         (medicine, prescriptions, plasters, supplements)
  health_service   (doctor visit, physio, dentist consultation, lab fee)
  clothing         (clothes, shoes, accessories)
  electronics      (devices, cables, batteries)
  appliances       (washing machine, kettle, vacuum)
  baby_kids        (diapers, toys, kids clothing — only if clearly for child)
  pet              (pet food, vet supplies, accessories)
  fuel             (petrol, diesel, EV charging)
  transport        (public transport, taxi, parking, tolls)
  travel           (hotel, flight, train tickets, holiday)
  entertainment    (movie, game, books, hobby, gym entry)
  subscription     (Netflix, Spotify, software, magazine, recurring service)
  utilities        (electricity, gas, water, internet, phone bill line)
  housing          (rent, mortgage, repairs, furniture)
  diy_garden       (hardware store items, plants, tools)
  office_supplies  (stationery, printer ink, postage)
  professional_service (lawyer, accountant, consultant, repair labor)
  insurance        (premium line on a policy or invoice)
  tax_fee          (VAT-only line, government fees, surcharges)
  gift             (clearly a present — flowers, gift cards)
  donation         (charity contribution)
  discount         (negative line, coupon, promo — total should be negative)
  deposit_return   (statiegeld / bottle return — usually negative)
  shipping         (delivery, postage line on an order)
  other            (genuinely doesn't fit anything above)

  Pick categories from the BUYER's perspective. A wine bottle on a supermarket receipt is "alcohol", not "groceries". A line that says "Korting" / "Discount" / negative amount is "discount". Statiegeld / bottle return is "deposit_return".

- Identifying facts that help match a document to a person — ALWAYS put these in extracted_fields when visible, with these exact keys:
  birth_date (YYYY-MM-DD or DD-MM-YYYY as written), bsn, national_id, patient_number, patient_code, policy_number, iban, customer_number, employee_number, address, postal_code, city.
  These are signals the profile matcher will cross-reference against profile attributes.

- If a field is not present on the document, use null (or omit from extracted_fields). Never invent data.
- For languages other than English, translate "title", "summary", and "tags" into English but keep "ocr_text" AND line_items descriptions in the original language.
- "needs_action" should be true ONLY for documents that imply concrete action by the recipient. Routine confirmations, archived statements, and informational letters should be false.
- For "purchase_category": pick the closest match from the list. Use null if the document is not a purchase.
- "profile_hint" should be the actual name as written on the doc — the server will fuzzy-match it to existing profiles.
- If the image is unreadable or clearly not a document (blank page, random photo), set document_type to "other", confidence low, and explain in "summary".

Return ONLY the JSON object.`;

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
