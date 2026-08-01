/**
 * OpenAI chat/completions -> Responses API shim.
 *
 * Vapi's custom-llm provider speaks the chat/completions protocol. The A1 gateway
 * only exposes the Responses API — and rejects `stream: true` — so we make one
 * non-streaming upstream call, then replay the result to Vapi as chat.completion
 * SSE chunks (or plain JSON when the client didn't ask for a stream).
 */
import type { Request, Response } from "express";
import { env } from "./env.js";

type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
};

function toResponsesInput(messages: ChatMessage[]): unknown[] {
  const items: unknown[] = [];
  for (const m of messages) {
    if (m.role === "tool") {
      items.push({ type: "function_call_output", call_id: m.tool_call_id, output: m.content ?? "" });
    } else if (m.role === "assistant" && m.tool_calls?.length) {
      if (m.content) items.push({ role: "assistant", content: m.content });
      for (const tc of m.tool_calls) {
        items.push({ type: "function_call", call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments });
      }
    } else {
      items.push({ role: m.role, content: m.content ?? "" });
    }
  }
  return items;
}

function toResponsesTools(tools?: { type: string; function?: { name: string; description?: string; parameters?: unknown } }[]) {
  if (!tools?.length) return undefined;
  return tools
    .filter((t) => t.type === "function" && t.function)
    .map((t) => ({
      type: "function",
      name: t.function!.name,
      description: t.function!.description,
      parameters: t.function!.parameters ?? { type: "object", properties: {} },
    }));
}

export async function chatCompletions(req: Request, res: Response) {
  const body = req.body ?? {};
  const model: string = body.model || env.irisModel;
  const started = Date.now();

  const upstreamBody: Record<string, unknown> = {
    model,
    input: toResponsesInput(body.messages ?? []),
  };
  const tools = toResponsesTools(body.tools);
  if (tools) upstreamBody.tools = tools;
  // The A1 gateway 400s on sampling params (temperature/top_p), so never forward them.
  if (body.max_tokens != null) upstreamBody.max_output_tokens = body.max_tokens;

  const upstream = await fetch(`${env.aiGatewayBaseUrl}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.aiGatewayKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(upstreamBody),
  });

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    console.error(`[shim] upstream error ${upstream.status}: ${text.slice(0, 500)}`);
    res.status(502).json({ error: { message: `AI gateway error ${upstream.status}`, detail: text.slice(0, 500) } });
    return;
  }

  const response: any = await upstream.json();

  // Flatten Responses output items into chat-completions message shape.
  let content = "";
  const toolCalls: { id: string; type: "function"; function: { name: string; arguments: string } }[] = [];
  for (const item of response.output ?? []) {
    if (item.type === "message") {
      for (const part of item.content ?? []) {
        if (part.type === "output_text") content += part.text ?? "";
      }
    } else if (item.type === "function_call") {
      toolCalls.push({
        id: item.call_id ?? item.id,
        type: "function",
        function: { name: item.name, arguments: item.arguments ?? "{}" },
      });
    }
  }
  const finishReason = toolCalls.length ? "tool_calls" : "stop";
  console.log(`[shim] ${model} responded in ${Date.now() - started}ms (${content.length} chars, ${toolCalls.length} tool calls)`);

  const id = `chatcmpl-shim-${Math.random().toString(36).slice(2)}`;
  const created = Math.floor(Date.now() / 1000);

  if (body.stream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    const delta: Record<string, unknown> = {};
    if (content) delta.content = content;
    if (toolCalls.length) delta.tool_calls = toolCalls.map((tc, index) => ({ index, ...tc }));
    res.write(
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }],
      })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      })}\n\n`,
    );
    res.write("data: [DONE]\n\n");
    res.end();
  } else {
    res.json({
      id,
      object: "chat.completion",
      created,
      model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: content || null,
            ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: finishReason,
        },
      ],
      usage: response.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  }
}
