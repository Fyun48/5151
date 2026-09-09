/** 刊登說明：允許簡易格式，禁止超連結與腳本。 */

export const LISTING_BODY_PLAIN_MAX = 500;
export const LISTING_BODY_HTML_MAX = 2500;

const ALLOWED_TAGS = new Set(["b", "strong", "i", "em", "u", "br", "p", "span", "div"]);
const ALLOWED_STYLE = /^(color|font-size|font-weight|font-style|text-decoration)$/i;
const SAFE_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const SAFE_SIZE = /^\d{1,2}(?:\.\d+)?px$/i;
const SAFE_WEIGHT = /^(normal|bold|[1-9]00)$/i;
const SAFE_DECO = /^(none|underline)$/i;

export function listingBodyPlain(value) {
  return String(value || "")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*p\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanStyle(raw) {
  return String(raw || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const idx = part.indexOf(":");
      if (idx < 0) return "";
      const name = part.slice(0, idx).trim();
      const value = part.slice(idx + 1).trim();
      if (!ALLOWED_STYLE.test(name)) return "";
      const key = name.toLowerCase();
      if (key === "color" && SAFE_COLOR.test(value)) return `color:${value}`;
      if (key === "font-size" && SAFE_SIZE.test(value)) return `font-size:${value}`;
      if (key === "font-weight" && SAFE_WEIGHT.test(value)) return `font-weight:${value}`;
      if (key === "font-style" && /^(normal|italic)$/i.test(value)) return `font-style:${value.toLowerCase()}`;
      if (key === "text-decoration" && SAFE_DECO.test(value)) return `text-decoration:${value.toLowerCase()}`;
      return "";
    })
    .filter(Boolean)
    .join(";");
}

export function sanitizeListingBodyHtml(value, maxPlain = LISTING_BODY_PLAIN_MAX) {
  let text = String(value ?? "").replace(/\0/g, "").replace(/\r\n/g, "\n");
  text = text
    .replace(/<\s*script[\s\S]*?>[\s\S]*?<\s*\/\s*script\s*>/gi, "")
    .replace(/<\s*(a|iframe|object|embed|link|meta|style|form|input|button|textarea|svg|img|math)[\s\S]*?>[\s\S]*?<\/\s*\1\s*>/gi, "")
    .replace(/<\s*(a|iframe|object|embed|link|meta|style|form|input|button|textarea|svg|img|math)\b[^>]*>/gi, "")
    .replace(/\s(?:on\w+|href|src|srcset|xlink:href|formaction|action)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/javascript\s*:/gi, "");
  text = text.replace(/<\/?([a-z0-9]+)([^>]*)>/gi, (match, tag, attrs) => {
    const name = String(tag || "").toLowerCase();
    if (!ALLOWED_TAGS.has(name)) return "";
    if (name === "br") return "<br>";
    if (match.startsWith("</")) return `</${name}>`;
    const styleMatch = String(attrs || "").match(/style\s*=\s*["']([^"']*)["']/i);
    const style = styleMatch ? cleanStyle(styleMatch[1]) : "";
    return style ? `<${name} style="${style}">` : `<${name}>`;
  });
  const plain = listingBodyPlain(text);
  if (plain.length > maxPlain) {
    return listingBodyPlain(text).slice(0, maxPlain);
  }
  return text.slice(0, LISTING_BODY_HTML_MAX).trim();
}

export function listingBodyHasUnsafe(value) {
  return /<\s*script\b|<\s*iframe\b|javascript\s*:|on[a-z]+\s*=|<\s*a\b/i.test(String(value || ""));
}
