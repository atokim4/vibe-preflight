import { scanProject, type ScanResult } from "./engine.ts";
import { loadProject } from "./project.ts";

export { counts, failsAt, scanProject, type ScanResult } from "./engine.ts";

export interface ScanOptions {
  /** Evaluate date-based checks as of this day (YYYY-MM-DD). Defaults to today in UTC. */
  today?: string;
}

/** Scans a folder on disk. */
export function scan(root: string, skip: string[] = [], options: ScanOptions = {}): ScanResult {
  return scanProject(loadProject(root, options.today), skip);
}
