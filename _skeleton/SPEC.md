# SPEC: <template-name>

## Purpose

TODO: Give a one-line description for the template picker. Explain which
identity makes the request and what Keycard protects or grants.

## Keycard provisioning

TODO: List the required Application, Resources, and credential provider.
Specify identifiers or how to derive them, and give the resource kind,
transport, endpoint, and dependency relationships where applicable. Include
the minimum Cedar policy as code if a custom policy is required, or say if
no custom policy is needed.

## Configuration to write

TODO: List the exact `.env` keys and how to derive their values. Say which
values are optional, which have defaults, and how to supply credentials safely.
Specify the source for the org and zone IDs and what goes in `[credentials]`
in `keycard.toml`. Keep this in sync with the code and `.env.example`.

## Verification

TODO: Give exact install, build, start, and smoke-test commands and their
expected results. Include the expected authentication behavior.

## What the agent must not do

Do not commit secrets or invent resource identifiers. TODO: List any
template-specific actions the agent must avoid.

## Handoff

TODO: List the identifiers, URLs, and next steps the agent should give the
user after setup. Do not include credentials.
