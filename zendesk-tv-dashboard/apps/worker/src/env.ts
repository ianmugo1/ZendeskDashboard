import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

export function loadEnvFiles(): void {
  const cwd = process.cwd();
  const candidates = [
    path.resolve(cwd, ".env"),
    path.resolve(cwd, "..", ".env"),
    path.resolve(cwd, "..", "..", ".env")
  ];

  for (const envPath of candidates) {
    if (fs.existsSync(envPath)) {
      dotenv.config({ path: envPath, override: false });
    }
  }
}
