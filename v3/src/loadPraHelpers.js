import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HELPERS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "../public/pra-helpers.js");

export function loadPraHelpers() {
  const sandbox = {
    crypto: globalThis.crypto,
    Uint8Array,
    console,
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  runInNewContext(readFileSync(HELPERS_PATH, "utf8"), sandbox, { filename: "pra-helpers.js" });
  if (!sandbox.PraHelpers) throw new Error("pra-helpers.js did not install PraHelpers");
  return sandbox.PraHelpers;
}
