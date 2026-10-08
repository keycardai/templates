/**
 * Writes a template's keycard.toml in the shape the Keycard CLI reads: an
 * [org] id and a [zone] id, which is what every template ships with
 * placeholders. The CLI decodes the file strictly and warns on any key it
 * does not know, so nothing harness-specific goes in here. A [credentials]
 * table the template already carries is kept as is.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

const PLACEHOLDER_ORG_ID = "<org-id>";

function tomlId(content: string, table: string): string | undefined {
  const match = content.match(new RegExp(`^\\[${table}\\][^\\[]*^\\s*id\\s*=\\s*"([^"]+)"`, "ms"));
  return match?.[1];
}

/**
 * The org id the eval runs under: EVAL_ORG_ID, else eval/keycard.toml's
 * [org] id, else the placeholder the template ships. The zone API does not
 * report its organization, so the harness cannot derive it from the zone.
 */
async function evalOrgId(): Promise<string> {
  if (process.env.EVAL_ORG_ID) return process.env.EVAL_ORG_ID;
  try {
    const own = await fs.readFile(new URL("keycard.toml", import.meta.url), "utf8");
    const id = tomlId(own, "org");
    if (id && id !== PLACEHOLDER_ORG_ID) return id;
  } catch { /* eval/keycard.toml optional */ }
  return PLACEHOLDER_ORG_ID;
}

export function renderKeycardToml(opts: { orgId: string; zoneId: string; existing: string }): string {
  const lines = opts.existing.split("\n");
  const credentialsStart = lines.findIndex((line) => /^\s*\[\[?credentials\b/.test(line));
  const credentials = credentialsStart >= 0 ? lines.slice(credentialsStart).join("\n").replace(/\s+$/, "") : "";
  const head = `[org]\nid = "${opts.orgId}"\n\n[zone]\nid = "${opts.zoneId}"\n`;
  return credentials ? `${head}\n${credentials}\n` : head;
}

export async function writeKeycardToml(templateDir: string, zoneId: string): Promise<string> {
  const file = path.join(templateDir, "keycard.toml");
  const existing = await fs.readFile(file, "utf8").catch(() => "");
  const content = renderKeycardToml({ orgId: await evalOrgId(), zoneId, existing });
  await fs.writeFile(file, content, "utf8");
  return content;
}
