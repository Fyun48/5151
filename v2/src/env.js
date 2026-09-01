import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

function parseEnvFile(file) {
  if (!existsSync(file)) return;
  const text = readFileSync(file, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined || String(process.env[key]).trim() === "") {
      process.env[key] = value;
    }
  }
}

if (!process.env.PORT) process.env.PORT = "5152";

const cwdEnv = path.join(process.cwd(), ".env");
parseEnvFile(cwdEnv);

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data-v2");
mkdirSync(DATA_DIR, { recursive: true });
parseEnvFile(path.join(DATA_DIR, "auth.env"));

if (!process.env.SESSION_SECRET) {
  const secretFile = path.join(DATA_DIR, "session.secret");
  if (existsSync(secretFile)) {
    process.env.SESSION_SECRET = readFileSync(secretFile, "utf8").trim();
  } else {
    const secret = randomBytes(32).toString("hex");
    writeFileSync(secretFile, secret, { encoding: "utf8", mode: 0o600 });
    process.env.SESSION_SECRET = secret;
  }
}
