// One completion from the Clawnify platform's model endpoint, with the org's
// token: each call is charged to the org's credits and follows its data region.
// Used by AI columns and by the meeting digest.

export interface AiEnv {
  CLAWNIFY_TOKEN?: string;
  CLAWNIFY_API_URL?: string;
  CLAWNIFY_SERVICES_URL?: string;
}

/** Fast and inexpensive, and served in every data region the platform routes to. */
export const MODEL = "google/gemini-3.1-flash-lite";
/** The model research falls back to where only a model's own search is allowed (the platform's in-region search model). */
const REGIONAL_SEARCH_MODEL = "google/gemini-3.5-flash-lite";

export class ModelError extends Error {
  constructor(message: string, readonly outOfCredits = false) {
    super(message);
  }
}

/**
 * With `research`, the answer is grounded in a web search: OpenRouter's web
 * plugin, billed with the call. Hosts pinned to a data region refuse external
 * search engines and allow only a model's own search, so a refusal is retried
 * once that way, on a model that has it in-region. Without it, the answer is
 * asked for as JSON.
 */
export async function complete(
  env: AiEnv,
  system: string,
  user: string,
  opts: { research?: boolean; maxTokens?: number; timeoutMs: number },
): Promise<string> {
  if (!env.CLAWNIFY_TOKEN) throw new ModelError("AI isn't available here: the app has no Clawnify token");
  const base = (env.CLAWNIFY_API_URL || "https://api.clawnify.com").replace(/\/+$/, "");
  const ask = async (extra: Record<string, unknown>) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.CLAWNIFY_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.2,
        max_tokens: opts.maxTokens ?? 600,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        ...extra,
      }),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    if (res.status === 402) throw new ModelError("Out of Clawnify credits", true);
    const body = await res.json().catch(() => null) as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } } | null;
    return { ok: res.ok, status: res.status, error: body?.error?.message, content: body?.choices?.[0]?.message?.content ?? "" };
  };
  // A web answer comes back as text around the JSON (the caller finds it), so no JSON mode then.
  let r = await ask(opts.research ? { plugins: [{ id: "web", max_results: 5 }] } : { response_format: { type: "json_object" } });
  if (!r.ok && opts.research && /data region/i.test(r.error ?? "")) {
    r = await ask({ model: REGIONAL_SEARCH_MODEL, plugins: [{ id: "web", engine: "native" }] });
  }
  if (!r.ok) throw new ModelError(r.error || `The AI service answered ${r.status}`);
  return r.content;
}
