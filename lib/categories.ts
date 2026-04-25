/**
 * CANONICAL LINE-ITEM CATEGORIES — single source of truth.
 *
 * Used by:
 *   - Paperfile extraction prompt (lib/ai/prompts.ts → buildLineItemCategoryBlock)
 *   - Paperfile UI (components/inbox/line-items.tsx)
 *   - Bookkeeping app extraction prompt (bookkeeping-aiuto/lib/categories.ts —
 *     KEEP IN SYNC with this file; running `npm run check:categories` from
 *     either project compares the two and fails if they diverge.)
 *
 * Bilingual on purpose: `en_label` is what we show in the English UI;
 * `nl_label` is what we show in Dutch contexts (e.g. the bookkeeping app's
 * Dutch invoice review screen). The `key` is what gets stored — never change
 * a key after release without a data migration.
 */

export interface LineItemCategoryDef {
  /** Stable machine key. Stored in extracted_fields.line_items[].category. */
  key: string;
  /** English label shown in the Paperfile UI. */
  en_label: string;
  /** Dutch label, shown in the bookkeeping app and Dutch contexts. */
  nl_label: string;
  /** One-line guidance Claude uses to decide which key to assign. */
  description: string;
}

export const LINE_ITEM_CATEGORIES: LineItemCategoryDef[] = [
  // Food & drink
  { key: "groceries", en_label: "Groceries", nl_label: "Boodschappen",
    description: "Bread, milk, fruit, veg, meat — everyday supermarket food." },
  { key: "alcohol", en_label: "Alcohol", nl_label: "Alcohol",
    description: "Beer, wine, spirits — anywhere they appear." },
  { key: "beverages", en_label: "Beverages", nl_label: "Dranken",
    description: "Soft drinks, coffee, tea, water, juice — non-alcoholic." },
  { key: "restaurant", en_label: "Restaurant", nl_label: "Restaurant",
    description: "Eat-in/take-out meals, café tabs, bar tabs, food delivery." },

  // Household & personal
  { key: "household", en_label: "Household", nl_label: "Huishouden",
    description: "Cleaning supplies, paper goods, kitchenware, light bulbs." },
  { key: "toiletries", en_label: "Toiletries", nl_label: "Toiletartikelen",
    description: "Shampoo, soap, dental, cosmetics, personal-care products." },
  { key: "pharmacy", en_label: "Pharmacy", nl_label: "Apotheek",
    description: "Medicine, prescriptions, plasters, supplements, vitamins." },
  { key: "health_service", en_label: "Health service", nl_label: "Zorg",
    description: "Doctor, physio, dentist consult, lab fee — the SERVICE not the medicine." },

  // Goods
  { key: "clothing", en_label: "Clothing", nl_label: "Kleding",
    description: "Clothes, shoes, accessories — adult." },
  { key: "electronics", en_label: "Electronics", nl_label: "Elektronica",
    description: "Devices, cables, batteries, accessories." },
  { key: "appliances", en_label: "Appliances", nl_label: "Apparaten",
    description: "Washing machine, kettle, vacuum, kitchen appliances." },
  { key: "baby_kids", en_label: "Baby & kids", nl_label: "Baby & kinderen",
    description: "Diapers, toys, kids' clothing — only when clearly for a child." },
  { key: "pet", en_label: "Pet", nl_label: "Huisdier",
    description: "Pet food, vet supplies, accessories." },

  // Mobility
  { key: "fuel", en_label: "Fuel", nl_label: "Brandstof",
    description: "Petrol, diesel, EV charging." },
  { key: "transport", en_label: "Transport", nl_label: "Vervoer",
    description: "Public transport, taxi, parking, tolls." },
  { key: "travel", en_label: "Travel", nl_label: "Reizen",
    description: "Hotel, flight, train tickets, holiday-related." },

  // Lifestyle
  { key: "entertainment", en_label: "Entertainment", nl_label: "Vermaak",
    description: "Movie, game, books, hobby, gym entry." },
  { key: "subscription", en_label: "Subscription", nl_label: "Abonnement",
    description: "Netflix, Spotify, software, magazine — recurring services." },
  { key: "gift", en_label: "Gift", nl_label: "Cadeau",
    description: "Clearly a present — flowers, gift cards, presents." },
  { key: "donation", en_label: "Donation", nl_label: "Donatie",
    description: "Charity contribution." },

  // Home & utilities
  { key: "utilities", en_label: "Utilities", nl_label: "Nutsvoorzieningen",
    description: "Electricity, gas, water, internet, phone bill line." },
  { key: "housing", en_label: "Housing", nl_label: "Wonen",
    description: "Rent, mortgage, repairs, furniture." },
  { key: "diy_garden", en_label: "DIY & garden", nl_label: "Doe-het-zelf & tuin",
    description: "Hardware store items, plants, tools." },

  // Work
  { key: "office_supplies", en_label: "Office supplies", nl_label: "Kantoorartikelen",
    description: "Stationery, printer ink, postage." },
  { key: "professional_service", en_label: "Professional service", nl_label: "Zakelijke dienst",
    description: "Lawyer, accountant, consultant, repair labour." },
  { key: "insurance", en_label: "Insurance", nl_label: "Verzekering",
    description: "Premium line on a policy or invoice." },

  // Adjustments / non-product
  { key: "tax_fee", en_label: "Tax / fee", nl_label: "Belasting / heffing",
    description: "VAT-only line, government fees, surcharges." },
  { key: "shipping", en_label: "Shipping", nl_label: "Verzending",
    description: "Delivery, postage line on an order." },
  { key: "discount", en_label: "Discount", nl_label: "Korting",
    description: "Negative line, coupon, promo — the line total should be negative." },
  { key: "deposit_return", en_label: "Deposit return", nl_label: "Statiegeld",
    description: "Bottle/crate return — usually negative." },

  // Catch-all
  { key: "other", en_label: "Other", nl_label: "Overig",
    description: "Genuinely doesn't fit any of the categories above." },
];

/** Lookup map by key for fast access. */
export const LINE_ITEM_CATEGORY_MAP: Record<string, LineItemCategoryDef> =
  Object.fromEntries(LINE_ITEM_CATEGORIES.map((c) => [c.key, c]));

/** Just the keys — useful for prompts and validation. */
export const LINE_ITEM_CATEGORY_KEYS = LINE_ITEM_CATEGORIES.map((c) => c.key);

/**
 * Render the canonical list as a Markdown-friendly block to inject directly
 * into a Claude prompt. Keeps the prompt and the canonical list in lock-step:
 * adding/renaming a category here automatically updates every prompt that
 * embeds this block.
 */
export function buildLineItemCategoryBlock(): string {
  return LINE_ITEM_CATEGORIES.map(
    (c) => `  ${c.key.padEnd(22)} (${c.nl_label}) — ${c.description}`
  ).join("\n");
}
