# Working in this repo

## Coding agents

These rules apply to Devin, Claude Code, and other coding agents:

1. Start with [CONTRIBUTING.md](./CONTRIBUTING.md) and the template's
   `SPEC.md`. Scope a PR to one template or one language group.
2. Keep `SPEC.md` and the code in sync, including config, build commands,
   and verification steps.
3. Run the Template CI verify job for the language. Follow the contribution
   guide for eval coverage before merge, and never run overlapping evals
   against the shared eval zone.
4. Never edit secrets, repo settings, or zone config.
5. Open PRs ready for review, not as drafts. Include check evidence and
   address bot review findings before reporting the PR ready.
6. Do not use em dashes or en dashes in code, comments, commit messages,
   docs, or PR text.
