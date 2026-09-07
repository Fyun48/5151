/** 受管文件的安全清洗與渲染。禁止任意 HTML／腳本；允許繁中、Unicode、emoji。 */

export const CONTENT_BODY_MAX = 20_000;
export const CONTENT_TITLE_MAX = 160;
export const CONTENT_CHECK_MAX = 200;

const UNSAFE_RE = /<\s*script\b|<\s*iframe\b|<\s*object\b|<\s*embed\b|javascript\s*:|data\s*:\s*text\/html|on[a-z]+\s*=/i;

export function containsUnsafeMarkup(value) {
  return UNSAFE_RE.test(String(value || ""));
}

export function sanitizeDocumentText(value, max) {
  return String(value ?? "").replace(/\0/g, "").replace(/\r\n/g, "\n").trim().slice(0, max);
}

export function sanitizeDocumentBody(body, format = "plain") {
  let text = sanitizeDocumentText(body, CONTENT_BODY_MAX);
  if (containsUnsafeMarkup(text)) {
    text = text
      .replace(/<\s*script[\s\S]*?>[\s\S]*?<\s*\/\s*script\s*>/gi, "")
      .replace(/<\s*(iframe|object|embed)[\s\S]*?>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
      .replace(/javascript\s*:/gi, "")
      .replace(/on[a-z]+\s*=\s*(['"]).*?\1/gi, "")
      .replace(/<[^>]+>/g, "");
  }
  if (format === "markdown") {
    text = text.replace(/<[^>]+>/g, "");
  }
  return text.slice(0, CONTENT_BODY_MAX);
}

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

/** 將清洗後的本文轉成安全 HTML（段落／換行；markdown 僅 **粗體** 與 - 條列）。 */
export function renderSafeContent(body, format = "plain") {
  const clean = sanitizeDocumentBody(body, format);
  if (!clean) return "";
  const blocks = clean.split(/\n{2,}/);
  return blocks.map((block) => {
    const lines = block.split("\n");
    const list = lines.length && lines.every((line) => /^\s*[-*]\s+/.test(line));
    if (list) {
      const items = lines.map((line) => `<li>${inlineSafe(line.replace(/^\s*[-*]\s+/, ""), format)}</li>`).join("");
      return `<ul>${items}</ul>`;
    }
    return `<p>${lines.map((line) => inlineSafe(line, format)).join("<br />")}</p>`;
  }).join("");
}

function inlineSafe(text, format) {
  const escaped = escapeHtml(text);
  if (format !== "markdown") return escaped;
  return escaped.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}
