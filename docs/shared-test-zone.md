# Shared SDK test zone

The shared SDK test zone is the Organization Zone of the organization used by
[Template Eval](../eval/README.md). Use your own Keycard account as a member of
that organization. Ask an organization admin to add you if you cannot see it
in Keycard Console. Use that Organization Zone and its issuer in your test
configuration, not the Keycard ID Zone you use to sign in.

## Rules for sharing the zone

1. Never change the zone's sign-in, identity provider, or invite settings. The
   nightly Template Eval preflight checks the sign-in configuration and test
   user before it runs any templates.
2. Prefix the names of the applications and resources you create with a
   personal or project prefix. Use it in identifiers where your SDK or
   template allows it, and do not use the eval's `eval-` prefix. Resource
   identifiers must be unique in the zone, so also avoid an unqualified
   default localhost identifier for shared-zone tests. Remove your test
   resources when you are done.

## Try an SDK by hand

Sign in to Keycard Console or run `keycard auth signin` for the CLI. Select
the shared Organization Zone and create the application or resource the SDK
example needs in Console. From the CLI, use `keycard agent api` with the
organization and zone, following the application or resource examples in the
[Express template SPEC](../mcp-server-typescript-express/SPEC.md).

Point your code at the shared zone's OAuth issuer, for example through
`KEYCARD_URL` in templates that use that setting. Set the resource identifier
in your code to match the one you registered.

## Start from a template

Ask your coding agent to pick the closest [template](../README.md#available-templates)
for your language and Keycard flow. Have it follow the template's `SPEC.md` to
provision in the shared Organization Zone, name your resources, and write the
local config. Use the organization and zone IDs in your local `keycard.toml`
and the issuer in the runtime config specified by the template.

Install and build as directed by the template. Run it locally with
`keycard run -- <template-start-command>`, using the documented start command.
See the [eval README's Run section](../eval/README.md#run) for the same
`keycard run --` wrapper around a single-template eval. If you need to run the
harness itself against the shared zone, first check that no other Template Eval
is using it.

## Test from CI in another repository

Get a dedicated service account credential authorized for the shared
Organization Zone from an organization admin. Store its client ID and client
secret as CI secrets in the repository that runs the tests. Set the test
target to the Organization Zone and its issuer. Do not reuse the template
eval's service account or put any credential in source code.

Follow the [Template Eval workflow](../.github/workflows/eval.yml) for the
pattern: inject the service account credentials from repository secrets, use
them to obtain a management API token, and create only the prefixed resources
your tests need. Delete your run's applications and resources at job end,
including after a failure.
