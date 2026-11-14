import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = mkdtempSync(path.join(tmpdir(), "session-history-tests-"));
try {
  const tests = readdirSync(path.join(root, "tests")).filter((name) => name.endsWith(".test.ts"));
  execFileSync(process.execPath, [
    path.join(root, "node_modules/typescript/bin/tsc"),
    "--outDir", output, "--noEmit", "false", "--module", "nodenext",
    "--target", "ES2022", "--skipLibCheck", ...tests.map((name) => `tests/${name}`),
  ], { cwd: root, stdio: "inherit" });
  writeFileSync(path.join(output, "package.json"), '{"type":"module"}\n');
  execFileSync(process.execPath, ["--test", ...tests.map((name) => path.join(output, "tests", name.replace(/\.ts$/, ".js")))], { stdio: "inherit" });
} finally {
  rmSync(output, { recursive: true, force: true });
}
