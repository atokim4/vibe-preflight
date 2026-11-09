import { run } from "./main.ts";
import { annotation } from "./github.ts";

try {
  process.exitCode = run();
} catch (error) {
  process.stdout.write(`${annotation("error", `vibe-preflight crashed: ${(error as Error).stack ?? String(error)}`)}\n`);
  process.exitCode = 1;
}
