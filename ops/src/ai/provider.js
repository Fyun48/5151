// AI Provider 抽象。系統不綁單一廠商；可換 stub / local(Ollama 相容) / 未來 OpenAI 相容等。
// provider 只負責「輸入 prompt → 回傳原始文字 + usage」；結構驗證集中在 ai/schema.js。
// 介面：
//   available: boolean            // 是否已設定（未設定則 worker 略過、不消耗 attempts）
//   async analyze({system,user,timeoutMs}) -> { rawText, usage:{input_tokens,output_tokens,latency_ms,estimated_cost} }
//   async health() -> { ok, ... }
//   getUsage() -> 累積用量
//
// 本階段不自動安裝 Ollama、不下載模型、不呼叫任何付費 API。

function nowMs() { return Date.now(); }

// ── Stub（測試用，決定性、零成本） ──
export function makeStubProvider(opts = {}) {
  const usage = { calls: 0 };
  return {
    name: "stub",
    available: true,
    async health() { return { ok: true, provider: "stub" }; },
    getUsage() { return { ...usage }; },
    async analyze({ user }) {
      usage.calls += 1;
      if (opts.behavior === "timeout") {
        const e = new Error("stub timeout"); e.name = "AbortError"; throw e;
      }
      if (opts.behavior === "error") throw new Error("stub provider error");
      if (opts.behavior === "malformed") return { rawText: "not-json <not an object>", usage: stubUsage() };
      if (opts.behavior === "badenum") return { rawText: JSON.stringify({ category: "NONSENSE", summary: "x", severity_hint: "LOW", confidence: 0.5, language: "en" }), usage: stubUsage() };
      if (opts.behavior === "badconfidence") return { rawText: JSON.stringify({ category: "BUG", summary: "x", severity_hint: "LOW", confidence: 5, language: "en" }), usage: stubUsage() };
      if (opts.behavior === "oversize") return { rawText: JSON.stringify({ category: "BUG", summary: "x".repeat(2000), severity_hint: "LOW", confidence: 0.5, language: "en" }), usage: stubUsage() };
      // 決定性關鍵字分類（僅供測試/離線）。
      let payload = {};
      try {
        const m = user.match(/FEEDBACK_DATA_BEGIN[^\n]*\n([\s\S]*?)\nFEEDBACK_DATA_END/);
        payload = m ? JSON.parse(m[1]) : {};
      } catch { payload = {}; }
      const content = String(payload.content || "");
      const lower = content.toLowerCase();
      const zh = /[\u4e00-\u9fff]/.test(content);
      let category = "OTHER";
      let severity = "LOW";
      if (/密碼|外洩|漏洞|password|token|security|vulnerab|xss|injection|rm -rf/.test(lower) || /密碼|外洩|漏洞/.test(content)) { category = "SECURITY"; severity = "HIGH"; }
      else if (/壞|錯誤|無法|不能|沒反應|轉圈|閃退|crash|error|bug|fail/.test(lower) || /壞|錯誤|無法|不能|沒反應|轉圈|閃退/.test(content)) { category = "BUG"; severity = "MEDIUM"; }
      else if (/慢|卡|lag|slow|loading|timeout|效能|performance/.test(lower) || /慢|卡|效能/.test(content)) { category = "PERFORMANCE"; severity = "MEDIUM"; }
      else if (/希望|建議|feature|add|想要|加上|請加/.test(lower) || /希望|建議|想要|加上/.test(content)) { category = "FEATURE_REQUEST"; severity = "LOW"; }
      else if (/醜|難用|介面|排版|ui|ux|layout/.test(lower) || /醜|難用|介面|排版/.test(content)) { category = "UX_UI"; severity = "LOW"; }
      else if (/怎麼|如何|請問|how do|question|help/.test(lower) || /怎麼|如何|請問/.test(content)) { category = "QUESTION_OR_USAGE"; severity = "LOW"; }
      const summary = (zh ? "使用者回報：" : "User reports: ") + content.slice(0, 120);
      const out = { category, summary, severity_hint: severity, confidence: 0.8, language: zh ? "zh-TW" : "en" };
      return { rawText: JSON.stringify(out), usage: stubUsage() };
    },
  };
}

function stubUsage() {
  // 不捏造 token 數；本地/stub 沒有就給 null。
  return { input_tokens: null, output_tokens: null, latency_ms: 1, estimated_cost: null };
}

// ── Local（Ollama 相容 HTTP） ──
export function makeLocalProvider(env = process.env) {
  const baseUrl = String(env.AI_BASE_URL || "").replace(/\/$/, "");
  const model = String(env.AI_MODEL || "");
  const cumulative = { calls: 0, input_tokens: 0, output_tokens: 0 };
  return {
    name: "local",
    available: Boolean(baseUrl && model),
    model,
    async health() {
      if (!baseUrl) return { ok: false, reason: "no_base_url" };
      try {
        const res = await fetch(`${baseUrl}/api/tags`, { method: "GET" });
        return { ok: res.ok };
      } catch (e) {
        return { ok: false, reason: e?.name || "error" };
      }
    },
    getUsage() { return { ...cumulative }; },
    async analyze({ system, user, timeoutMs = 20000 }) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const started = nowMs();
      try {
        const res = await fetch(`${baseUrl}/api/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model, system, prompt: user, stream: false, format: "json", options: { temperature: 0 } }),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`local provider HTTP ${res.status}`);
        const data = await res.json();
        cumulative.calls += 1;
        cumulative.input_tokens += Number(data.prompt_eval_count || 0);
        cumulative.output_tokens += Number(data.eval_count || 0);
        return {
          rawText: String(data.response ?? ""),
          usage: {
            input_tokens: data.prompt_eval_count ?? null,
            output_tokens: data.eval_count ?? null,
            latency_ms: nowMs() - started,
            estimated_cost: null,
          },
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function makeNullProvider() {
  return {
    name: "none",
    available: false,
    async health() { return { ok: false, reason: "not_configured" }; },
    getUsage() { return {}; },
    async analyze() { throw new Error("AI provider not configured"); },
  };
}

// 依環境變數選 provider。未設定 → Null（worker 會略過，不消耗 attempts）。
export function makeProvider(env = process.env) {
  const kind = String(env.AI_PROVIDER || "").toLowerCase();
  if (kind === "stub") return makeStubProvider();
  if (kind === "local") return makeLocalProvider(env);
  return makeNullProvider();
}
