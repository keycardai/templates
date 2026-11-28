import { randomUUID } from "node:crypto";

export function evalRunId(
  template: string,
  { GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT }: NodeJS.ProcessEnv = process.env,
): string {
  const run = GITHUB_RUN_ID ? `${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT ?? "1"}` : randomUUID();
  return `${template}--${run}`;
}

export function evalHostname(runId: string): string {
  // Separate the template and run into DNS labels to fit the per-label limit.
  return `${runId.replace("--", ".")}.localhost`;
}

export function evalOrigin(runId: string, port: number): string {
  return `http://${evalHostname(runId)}:${port}`;
}
