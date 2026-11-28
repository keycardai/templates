import { appendFile, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  addBuildAgentUsage,
  BUILD_AGENT_MODEL,
  type BuildAgentUsage,
  emptyBuildAgentUsage,
  formatBuildAgentUsage,
} from "./build-agent-usage.js";

const artifactDir = process.argv[2];
const templates: string[] = JSON.parse(process.env.EVAL_TEMPLATES ?? "[]");
const artifacts = await readdir(artifactDir).catch((err: NodeJS.ErrnoException) => {
  if (err.code === "ENOENT") return [];
  throw err;
});

const total = emptyBuildAgentUsage();
for (const artifact of artifacts) {
  const usage: BuildAgentUsage = JSON.parse(await readFile(join(artifactDir, artifact, "build-agent-usage.json"), "utf8"));
  addBuildAgentUsage(total, usage);
}

const summary = [
  `## Total build agent usage (${BUILD_AGENT_MODEL})`,
  "",
  `Usage reports from this run attempt: ${artifacts.length} of ${templates.length} templates.`,
  "",
  artifacts.length ? formatBuildAgentUsage(total) : "No build agent usage reports available.",
].join("\n");

console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, summary + "\n");
}
