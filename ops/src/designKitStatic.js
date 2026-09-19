import path from "node:path";

const KIT_TYPES = new Map([
  ["tokens.css", "text/css; charset=utf-8"],
  ["components.css", "text/css; charset=utf-8"],
  ["VERSION", "text/plain; charset=utf-8"],
  ["README.md", "text/markdown; charset=utf-8"],
  ["MANIFEST.json", "application/json; charset=utf-8"],
  ["themes/v3.css", "text/css; charset=utf-8"],
  ["themes/ops.css", "text/css; charset=utf-8"],
  ["themes/example.css", "text/css; charset=utf-8"],
]);

export function resolveKitStatic(pathname) {
  if (typeof pathname !== "string" || !pathname.startsWith("/kit/")) return null;
  const rel = pathname.slice("/kit/".length);
  if (!rel || rel.includes("\0") || rel.includes("\\") || rel.includes("..") || rel.startsWith("/") || rel.includes("//")) {
    return null;
  }
  const type = KIT_TYPES.get(rel);
  if (!type) return null;
  return { rel, type };
}

export function kitFilePath(publicDir, rel) {
  const parts = String(rel || "").split("/").filter(Boolean);
  if (!parts.length || parts.some((p) => p === ".." || p === ".")) {
    throw new Error("invalid kit path");
  }
  return path.join(publicDir, "kit", ...parts);
}
