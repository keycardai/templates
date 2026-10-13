/**
 * Stops a process group the harness started with `detached: true` and waits
 * until every member is gone. SIGTERM first so servers shut down cleanly,
 * then SIGKILL to the whole group if anything is still alive after the grace
 * period.
 *
 * Waiting matters for Python templates: `uv run` (0.13 and later) holds a
 * shared lock on the uv cache for as long as its child runs, and a uv
 * process that outlives the eval step blocks setup-uv's post-job cache prune
 * on that lock until uv's five-minute lock timeout fails the job.
 */
import type { ChildProcess } from "node:child_process";

const GRACE_MS = 5000;
const POLL_MS = 100;

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function stopProcessGroup(child: ChildProcess | undefined, graceMs = GRACE_MS): Promise<void> {
  const pid = child?.pid;
  if (!pid) return;
  try { process.kill(-pid, "SIGTERM"); } catch { return; }
  const deadline = Date.now() + graceMs;
  while (groupAlive(pid) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  if (groupAlive(pid)) {
    try { process.kill(-pid, "SIGKILL"); } catch { /* exited between checks */ }
    // Bounded too: a member stuck in the kernel must not hang the eval step,
    // which is the failure this helper exists to prevent.
    const killDeadline = Date.now() + graceMs;
    while (groupAlive(pid) && Date.now() < killDeadline) {
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    if (groupAlive(pid)) {
      console.warn(`process group ${pid} still alive ${graceMs}ms after SIGKILL; continuing`);
    }
  }
}
