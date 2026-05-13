import { z } from "zod";

const Env = z.object({
  AGENT_BASE_URL: z.string().url(),
  KEYCARD_URL: z.string().url(),
  SNOWFLAKE_ACCOUNT: z.string().min(1),

  AGENT_PROVIDER: z.string().default("anthropic"),
  AGENT_MODEL: z.string().default("claude-sonnet-4-20250514"),
  PORT: z.coerce.number().int().positive().default(9000),
  AGENT_KEYS_DIR: z.string().default("./agent_keys"),
  AGENT_NAME: z.string().default("autonomous-agent-snowflake-wif"),

  SNOWFLAKE_USER: z.string().optional(),
  SNOWFLAKE_DATABASE: z.string().optional(),
  SNOWFLAKE_WAREHOUSE: z.string().optional(),
  SNOWFLAKE_ROLE: z.string().optional(),
});

export type Env = z.infer<typeof Env>;

export function loadEnv(): Env {
  return Env.parse(process.env);
}
