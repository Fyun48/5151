import { createHash } from "node:crypto";

// Embedding Provider 抽象（與分類 provider 分離）。不綁單一廠商。
// 介面：
//   available: boolean
//   name, model, modelVersion, dim
//   async embed(texts:string[]) -> { vectors:number[][], model, model_version, dim, usage }
//   async health()
//   getUsage()
//
// 本階段不自動安裝/下載模型、不呼叫付費 API；測試用 stub。

// 相容性簽章：只有相同 (provider-neutral) model + model_version + dim + normalization_version 的向量才可互相比較。
export function embeddingSignature({ model, model_version, dim, normalization_version }) {
  return `${model}|${model_version || ""}|${dim}|${normalization_version}`;
}

export function areComparable(a, b) {
  return a && b &&
    a.model === b.model &&
    String(a.model_version || "") === String(b.model_version || "") &&
    Number(a.dim) === Number(b.dim) &&
    a.normalization_version === b.normalization_version;
}

export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ── Stub（測試用；決定性、零成本、以詞袋雜湊近似語意相似） ──
// 相同/相近文字 → 高 cosine；共享詞越多越相似。可離線重現。
export function makeStubEmbeddingProvider(opts = {}) {
  const dim = Number(opts.dim || 64);
  const model = opts.model || "stub-embed";
  const modelVersion = opts.modelVersion || "v1";
  const usage = { calls: 0 };
  function tokens(text) {
    const s = String(text || "").toLowerCase();
    const out = [];
    // 英數詞
    for (const m of s.match(/[a-z0-9]+/g) || []) out.push(m);
    // CJK：單字 + bigram
    const cjk = s.match(/[\u4e00-\u9fff]/g) || [];
    for (let i = 0; i < cjk.length; i++) {
      out.push(cjk[i]);
      if (i + 1 < cjk.length) out.push(cjk[i] + cjk[i + 1]);
    }
    return out;
  }
  function embedOne(text) {
    const vec = new Array(dim).fill(0);
    for (const t of tokens(text)) {
      const h = createHash("sha1").update(t).digest();
      const idx = h.readUInt32BE(0) % dim;
      const sign = (h[4] & 1) ? 1 : 1; // 用正權重讓共享詞提升相似度
      vec[idx] += sign;
    }
    // L2 normalize
    let n = 0; for (const v of vec) n += v * v;
    n = Math.sqrt(n) || 1;
    return vec.map((v) => v / n);
  }
  return {
    name: "stub",
    available: true,
    model,
    modelVersion,
    dim,
    async health() { return { ok: true, provider: "stub" }; },
    getUsage() { return { ...usage }; },
    async embed(texts) {
      if (opts.behavior === "timeout") { const e = new Error("stub embed timeout"); e.name = "AbortError"; throw e; }
      if (opts.behavior === "error") throw new Error("stub embed error");
      usage.calls += 1;
      const vectors = (texts || []).map(embedOne);
      return { vectors, model, model_version: modelVersion, dim, usage: { input_tokens: null, latency_ms: 1, estimated_cost: null } };
    },
  };
}

// ── Local（Ollama 相容 /api/embeddings） ──
export function makeLocalEmbeddingProvider(env = process.env) {
  const baseUrl = String(env.EMBEDDING_BASE_URL || "").replace(/\/$/, "");
  const model = String(env.EMBEDDING_MODEL || "");
  const modelVersion = String(env.EMBEDDING_MODEL_VERSION || "");
  const cumulative = { calls: 0 };
  return {
    name: "local",
    available: Boolean(baseUrl && model),
    model,
    modelVersion,
    dim: Number(env.EMBEDDING_DIM || 0) || null,
    async health() {
      if (!baseUrl) return { ok: false, reason: "no_base_url" };
      try { const r = await fetch(`${baseUrl}/api/tags`); return { ok: r.ok }; } catch (e) { return { ok: false, reason: e?.name || "error" }; }
    },
    getUsage() { return { ...cumulative }; },
    async embed(texts, { timeoutMs = 20000 } = {}) {
      const vectors = [];
      for (const text of texts || []) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const res = await fetch(`${baseUrl}/api/embeddings`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model, prompt: text }), signal: controller.signal,
          });
          if (!res.ok) throw new Error(`embedding provider HTTP ${res.status}`);
          const data = await res.json();
          vectors.push(data.embedding || []);
        } finally { clearTimeout(timer); }
      }
      cumulative.calls += 1;
      const dim = vectors[0]?.length || 0;
      return { vectors, model, model_version: modelVersion, dim, usage: { input_tokens: null, latency_ms: null, estimated_cost: null } };
    },
  };
}

export function makeNullEmbeddingProvider() {
  return {
    name: "none", available: false, model: null, modelVersion: null, dim: null,
    async health() { return { ok: false, reason: "not_configured" }; },
    getUsage() { return {}; },
    async embed() { throw new Error("embedding provider not configured"); },
  };
}

export function makeEmbeddingProvider(env = process.env) {
  const kind = String(env.EMBEDDING_PROVIDER || "").toLowerCase();
  if (kind === "stub") return makeStubEmbeddingProvider();
  if (kind === "local") return makeLocalEmbeddingProvider(env);
  return makeNullEmbeddingProvider();
}
