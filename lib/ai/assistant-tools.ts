/**
 * Tool definitions + executors for the Paperfile Assistant agent.
 *
 * Mirrors the proven Aiutofin Booking Assistant architecture:
 *  - READ tools: executed immediately (session-scoped via RLS), results
 *    fed back to Claude inside the tool-use loop.
 *  - ACTION tools: never executed inside the chat turn. previewAction()
 *    returns a PROPOSAL (what would change); the user confirms in the chat
 *    and the client calls /api/assistant/execute.
 *  - navigate: returns a directive the chat panel uses to route the user.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;

// ---------------------------------------------------------------------------
// Tool schemas (Anthropic tool-use format)
// ---------------------------------------------------------------------------

export const ASSISTANT_TOOLS: Anthropic.Tool[] = [
  {
    name: "search_documents",
    description:
      "Search the user's document archive. Full-text search over title, summary, sender, tags and the document's OCR text. Use this FIRST for any 'where is…', 'do I have…', 'find…' question. Returns up to 20 matches with links.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Free-text search (websearch syntax, e.g. 'insurance policy 2024' or 'CJIB boete'). Omit to list by filters only.",
        },
        document_type: {
          type: "string",
          description:
            "Filter by type, e.g. invoice, receipt, bank_statement, medical_bill, tax_document, letter, insurance_policy, contract, utility_bill, payslip, id_document.",
        },
        profile_id: { type: "number", description: "Filter by profile id" },
        date_from: { type: "string", description: "Document date >= YYYY-MM-DD" },
        date_to: { type: "string", description: "Document date <= YYYY-MM-DD" },
        limit: { type: "number", description: "Max results (default 10, max 20)" },
      },
    },
  },
  {
    name: "get_document",
    description:
      "Full details of one document by id: extracted fields, filing location, bookkeeping status, and its open/done actions. Use after search_documents when the user asks about one specific document.",
    input_schema: {
      type: "object",
      properties: {
        document_id: { type: "string", description: "Document uuid" },
      },
      required: ["document_id"],
    },
  },
  {
    name: "list_actions",
    description:
      "List the user's actions (to-dos derived from documents). Use for 'which fines are open', 'what do I still need to pay', 'show my done items'.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["open", "done", "dismissed", "all"] },
        search: { type: "string", description: "Text that must appear in the action summary" },
        document_id: { type: "string" },
        profile_id: { type: "number" },
        limit: { type: "number", description: "Max results (default 15, max 30)" },
      },
    },
  },
  {
    name: "refile_document",
    description:
      "PROPOSAL: move a document to a different profile and/or change its document type. The file is physically re-filed in storage. User must confirm.",
    input_schema: {
      type: "object",
      properties: {
        document_id: { type: "string" },
        profile_id: { type: "number", description: "New profile id (omit to keep)" },
        document_type: { type: "string", description: "New document type (omit to keep)" },
      },
      required: ["document_id"],
    },
  },
  {
    name: "create_action",
    description:
      "PROPOSAL: create a new action (to-do) in the Action Center, optionally linked to a document and with a due date. User must confirm.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "What needs to be done, imperative" },
        document_id: { type: "string", description: "Optional related document" },
        profile_id: { type: "number" },
        due_date: { type: "string", description: "YYYY-MM-DD, optional" },
        action_type: {
          type: "string",
          enum: ["pay", "respond", "sign", "file_with_authority", "send_to_bookkeeping", "other"],
        },
      },
      required: ["summary"],
    },
  },
  {
    name: "complete_action",
    description: "PROPOSAL: mark an action as done. User must confirm.",
    input_schema: {
      type: "object",
      properties: {
        action_id: { type: "string" },
        note: { type: "string", description: "Optional note recorded on the action" },
      },
      required: ["action_id"],
    },
  },
  {
    name: "dismiss_action",
    description: "PROPOSAL: dismiss an action as not relevant. User must confirm.",
    input_schema: {
      type: "object",
      properties: {
        action_id: { type: "string" },
      },
      required: ["action_id"],
    },
  },
  {
    name: "send_to_bookkeeping",
    description:
      "PROPOSAL: push a document (invoice, receipt, bill, bank statement) to the user's bookkeeping app (Aiutofin). Safe to repeat — the receiver skips duplicates. User must confirm.",
    input_schema: {
      type: "object",
      properties: {
        document_id: { type: "string" },
      },
      required: ["document_id"],
    },
  },
  {
    name: "reanalyze_document",
    description:
      "PROPOSAL: re-run the AI extraction on a document (when classification looks wrong or extraction failed). User must confirm.",
    input_schema: {
      type: "object",
      properties: {
        document_id: { type: "string" },
      },
      required: ["document_id"],
    },
  },
  {
    name: "navigate",
    description:
      "Route the user to a page so they can SEE what was discussed. Pages: 'inbox' (filters: q, type, profile_id), 'actions', 'document' (requires document_id), 'upload', 'profiles', 'reports', 'settings'.",
    input_schema: {
      type: "object",
      properties: {
        page: {
          type: "string",
          enum: ["inbox", "actions", "document", "upload", "profiles", "reports", "settings"],
        },
        document_id: { type: "string", description: "Required when page = document" },
        q: { type: "string", description: "Search prefilter for inbox" },
        type: { type: "string", description: "document_type prefilter for inbox" },
        profile_id: { type: "number" },
      },
      required: ["page"],
    },
  },
];

export const READ_TOOLS = new Set(["search_documents", "get_document", "list_actions"]);
export const ACTION_TOOLS = new Set([
  "refile_document",
  "create_action",
  "complete_action",
  "dismiss_action",
  "send_to_bookkeeping",
  "reanalyze_document",
]);

// ---------------------------------------------------------------------------
// READ tool executors — session client, RLS scopes everything to the user.
// ---------------------------------------------------------------------------

const DOC_FIELDS =
  "id, title, summary, sender, document_type, document_subtype, document_date, " +
  "primary_profile_id, amount, currency, tags, purchase_category, file_name, " +
  "needs_review, sent_to_bookkeeping_at, created_at";

function docLink(id: string): string {
  return `/document/${id}`;
}

export async function runReadTool(
  db: Db,
  name: string,
  input: Record<string, unknown>
): Promise<unknown> {
  if (name === "search_documents") {
    const limit = Math.min(20, Math.max(1, Number(input.limit) || 10));
    let q = db
      .from("documents")
      .select(DOC_FIELDS)
      .neq("status", "deleted")
      .order("created_at", { ascending: false })
      .limit(limit);
    const text = typeof input.query === "string" ? input.query.trim() : "";
    if (text) q = q.textSearch("fts", text, { type: "websearch", config: "simple" });
    if (typeof input.document_type === "string" && input.document_type)
      q = q.eq("document_type", input.document_type);
    if (typeof input.profile_id === "number")
      q = q.eq("primary_profile_id", input.profile_id);
    if (typeof input.date_from === "string" && input.date_from)
      q = q.gte("document_date", input.date_from);
    if (typeof input.date_to === "string" && input.date_to)
      q = q.lte("document_date", input.date_to);

    const { data, error } = await q;
    if (error) return { error: error.message };
    let rows = (data || []) as unknown as Record<string, unknown>[];

    // Full-text found nothing? Soften to ilike across the headline fields —
    // catches partial words and typos the websearch parser rejects.
    if (text && rows.length === 0) {
      const like = `%${text.replace(/[%_]/g, "")}%`;
      const { data: fallback } = await db
        .from("documents")
        .select(DOC_FIELDS)
        .neq("status", "deleted")
        .or(`title.ilike.${like},summary.ilike.${like},sender.ilike.${like}`)
        .order("created_at", { ascending: false })
        .limit(limit);
      rows = (fallback || []) as unknown as Record<string, unknown>[];
    }

    return {
      count: rows.length,
      documents: rows.map((d: Record<string, unknown>) => ({
        ...d,
        link: docLink(String(d.id)),
      })),
    };
  }

  if (name === "get_document") {
    const id = String(input.document_id || "");
    const { data: doc, error } = await db
      .from("documents")
      .select(
        DOC_FIELDS +
          ", recipient, dropbox_path, extracted_fields, ocr_text, bookkeeping_doc_id, due_date, action_summary"
      )
      .eq("id", id)
      .maybeSingle();
    if (error || !doc) return { error: error?.message || "Document not found" };

    const { data: actions } = await db
      .from("actions")
      .select("id, action_type, summary, status, due_date, completed_at")
      .eq("document_id", id)
      .order("created_at", { ascending: false })
      .limit(10);

    const d = doc as unknown as Record<string, unknown>;
    return {
      ...d,
      ocr_text: typeof d.ocr_text === "string" ? d.ocr_text.slice(0, 2000) : null,
      link: docLink(id),
      actions: actions || [],
    };
  }

  if (name === "list_actions") {
    const limit = Math.min(30, Math.max(1, Number(input.limit) || 15));
    const status = typeof input.status === "string" ? input.status : "open";
    let q = db
      .from("actions")
      .select("id, action_type, summary, status, due_date, completed_at, document_id, profile_id, notes")
      .order("due_date", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(limit);
    if (status !== "all") q = q.eq("status", status);
    if (typeof input.search === "string" && input.search)
      q = q.ilike("summary", `%${input.search.replace(/[%_]/g, "")}%`);
    if (typeof input.document_id === "string" && input.document_id)
      q = q.eq("document_id", input.document_id);
    if (typeof input.profile_id === "number")
      q = q.eq("profile_id", input.profile_id);

    const { data, error } = await q;
    if (error) return { error: error.message };
    return {
      count: (data || []).length,
      actions: (data || []).map((a: Record<string, unknown>) => ({
        ...a,
        document_link: a.document_id ? docLink(String(a.document_id)) : null,
      })),
    };
  }

  throw new Error(`Unknown read tool: ${name}`);
}

// ---------------------------------------------------------------------------
// ACTION proposals — describe what WOULD happen; nothing executes here.
// ---------------------------------------------------------------------------

export interface ActionProposal {
  tool: string;
  input: Record<string, unknown>;
  summary: string;
}

async function docTitle(db: Db, id: string): Promise<string> {
  const { data } = await db.from("documents").select("title, file_name").eq("id", id).maybeSingle();
  return (data?.title as string) || (data?.file_name as string) || id.slice(0, 8);
}

async function profileName(db: Db, id: number): Promise<string> {
  const { data } = await db.from("profiles").select("name").eq("id", id).maybeSingle();
  return (data?.name as string) || `#${id}`;
}

export async function previewAction(
  db: Db,
  name: string,
  input: Record<string, unknown>
): Promise<ActionProposal> {
  if (name === "refile_document") {
    const title = await docTitle(db, String(input.document_id));
    const parts: string[] = [];
    if (typeof input.profile_id === "number")
      parts.push(`profile → ${await profileName(db, input.profile_id)}`);
    if (typeof input.document_type === "string" && input.document_type)
      parts.push(`type → ${input.document_type}`);
    return { tool: name, input, summary: `Re-file "${title}" (${parts.join(", ") || "no changes"})` };
  }
  if (name === "create_action") {
    const due = typeof input.due_date === "string" && input.due_date ? ` (due ${input.due_date})` : "";
    return { tool: name, input, summary: `Create action: "${String(input.summary)}"${due}` };
  }
  if (name === "complete_action" || name === "dismiss_action") {
    const { data } = await db
      .from("actions")
      .select("summary")
      .eq("id", String(input.action_id))
      .maybeSingle();
    const verb = name === "complete_action" ? "Mark done" : "Dismiss";
    return { tool: name, input, summary: `${verb}: "${(data?.summary as string) || input.action_id}"` };
  }
  if (name === "send_to_bookkeeping") {
    const title = await docTitle(db, String(input.document_id));
    return { tool: name, input, summary: `Send "${title}" to bookkeeping (Aiutofin)` };
  }
  if (name === "reanalyze_document") {
    const title = await docTitle(db, String(input.document_id));
    return { tool: name, input, summary: `Re-run AI extraction on "${title}"` };
  }
  throw new Error(`Unknown action tool: ${name}`);
}
