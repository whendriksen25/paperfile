import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@/lib/supabase/server";
import {
  ASSISTANT_TOOLS,
  READ_TOOLS,
  ACTION_TOOLS,
  runReadTool,
  previewAction,
} from "@/lib/ai/assistant-tools";

export const runtime = "nodejs";
export const maxDuration = 120;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// POST /api/assistant — the Paperfile Assistant agent.
// Body: { message: string, history?: { role: "user"|"assistant", text: string }[] }
//
// Claude runs a tool-use loop:
//  - READ tools execute immediately (RLS-scoped to the session user).
//  - ACTION tools stop the loop and return a PROPOSAL — the user confirms
//    in the chat, which calls /api/assistant/execute.
//  - navigate returns a directive for the chat panel to route the user.
export async function POST(request: Request) {
  console.log("[api/assistant] POST start");

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const message: string = (body.message || "").trim();
  const history: { role: "user" | "assistant"; text: string }[] = Array.isArray(
    body.history
  )
    ? body.history.slice(-10)
    : [];
  if (!message) {
    return NextResponse.json({ error: "message required" }, { status: 400 });
  }

  const { data: profiles } = await supabase
    .from("profiles")
    .select("id, name, type, is_default")
    .order("name");
  const profileLines = (profiles || [])
    .map(
      (p) =>
        `- [${p.id}] ${p.name}${p.type ? ` (${p.type})` : ""}${p.is_default ? " — default" : ""}`
    )
    .join("\n");

  const system = `You are the Paperfile Assistant — a helper inside the user's personal document archive (receipts, invoices, medical forms, contracts, letters, bank statements, IDs, …).

Today is ${new Date().toISOString().slice(0, 10)}.

The user's profiles (documents are filed under these):
${profileLines || "(none yet)"}

How to work:
- FINDING THINGS is your primary job. For any "where is / do I have / find / show me" question: call search_documents first, then answer with the matches as markdown links, e.g. [ONVZ policy 2024](/document/abc-123). Never guess from memory — always search.
- For details on one document, use get_document. For to-dos/fines/payments use list_actions.
- When the user asks you to DO something (re-file, fix a wrong profile or type, create or close an action, send a document to bookkeeping, re-analyse), call the matching action tool. These are PROPOSALS — the user confirms them in the chat. Maximum one proposal per turn.
- When the user wants to SEE things in the app, use navigate (you can combine: answer first, then offer navigation).
- Reply in the user's language. Be short and concrete. Amounts with €. When a document or action can't be found, say so plainly and suggest a different search.`;

  const messages: Anthropic.MessageParam[] = [
    ...history.map(
      (h) => ({ role: h.role, content: h.text }) as Anthropic.MessageParam
    ),
    { role: "user", content: message },
  ];

  try {
    for (let turn = 0; turn < 6; turn++) {
      const response = await client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        temperature: 0,
        system,
        tools: ASSISTANT_TOOLS,
        messages,
      });

      const toolBlocks = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
      );
      const textBlocks = response.content.filter(
        (b): b is Anthropic.TextBlock => b.type === "text"
      );
      const text = textBlocks.map((b) => b.text).join("\n").trim();

      // No tools → final answer
      if (toolBlocks.length === 0 || response.stop_reason !== "tool_use") {
        console.log("[api/assistant] POST done — answer");
        return NextResponse.json({ type: "answer", reply: text || "…" });
      }

      const tool = toolBlocks[0];
      const input = (tool.input || {}) as Record<string, unknown>;
      console.log("[api/assistant] tool:", tool.name);

      // ── Navigation directive ──
      if (tool.name === "navigate") {
        const page = String(input.page || "inbox");
        let url: string;
        if (page === "document" && typeof input.document_id === "string") {
          url = `/document/${input.document_id}`;
        } else {
          const params = new URLSearchParams();
          if (typeof input.q === "string" && input.q) params.set("q", input.q);
          if (typeof input.type === "string" && input.type) params.set("type", input.type);
          if (typeof input.profile_id === "number")
            params.set("profile_id", String(input.profile_id));
          url = `/${page}${params.size ? `?${params.toString()}` : ""}`;
        }
        console.log("[api/assistant] POST done — navigate", url);
        return NextResponse.json({
          type: "navigate",
          url,
          reply: text || "Opening it for you.",
        });
      }

      // ── Action proposal (confirm-first) ──
      if (ACTION_TOOLS.has(tool.name)) {
        const proposal = await previewAction(supabase, tool.name, input);
        console.log("[api/assistant] POST done — proposal:", proposal.summary);
        return NextResponse.json({
          type: "action_proposal",
          proposal,
          reply: text || null,
        });
      }

      // ── Read tool: execute and continue the loop ──
      if (READ_TOOLS.has(tool.name)) {
        let result: unknown;
        try {
          result = await runReadTool(supabase, tool.name, input);
        } catch (err) {
          result = { error: err instanceof Error ? err.message : "query failed" };
        }
        messages.push({ role: "assistant", content: response.content });
        messages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: tool.id,
              content: JSON.stringify(result).slice(0, 30000),
            },
          ],
        });
        continue;
      }

      // Unknown tool — bail out gracefully
      return NextResponse.json({
        type: "answer",
        reply: text || "I can't do that (yet).",
      });
    }

    return NextResponse.json({
      type: "answer",
      reply: "That got too complex for one turn — can you split the question?",
    });
  } catch (err) {
    console.error("[api/assistant] error:", err);
    return NextResponse.json(
      { error: "Assistant failed. Try again." },
      { status: 500 }
    );
  }
}
