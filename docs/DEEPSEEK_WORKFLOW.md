# DeepSeek development workflow

The workflow is manual-only (`workflow_dispatch`). It never starts a paid call
unless the owner selects paid API use, supplies a positive per-run USD ceiling,
confirms the current official price list, and the balance preflight verifies
that topped-up USD credit covers that ceiling. The default ceiling is `0.00`;
no automatic top-up endpoint is used.

The free balance-only option calls `GET /user/balance`, checks only
`topped_up_balance` in USD, and suppresses the balance amount from Actions logs.
It fails closed when the provider returns only another currency or an invalid
response. A connection test is a paid Chat Completions request, but it uses the
same budget proxy and is limited to one response with 16 output tokens.

The coding job routes Aider through a loopback-only proxy. The proxy accepts
only `deepseek-flash`, non-streaming requests, one response per request, bounded
request size, and at most 40 calls. It normalizes output limits to a single
`max_tokens` value capped at 4096 (using 4096 when Aider omits a limit), then
reserves against that forwarded limit. It includes the entire serialized
request and output limit, applies a 2x safety factor, and settles against
provider usage. Once a request is reserved, provider errors, missing usage,
and unverified actual usage consume the full reservation and stop the run.
Requests rejected before reservation are not forwarded and are recorded as a
failed run without an API charge. The proxy gives Aider a short-lived local
token; the actual DeepSeek key is not passed to Aider.

The reserve calculation uses the official peak, uncached `deepseek-flash`
rates checked on 2026-11-26: USD 0.30 per million input tokens and USD 1.20 per
million output tokens. Cached input is charged at the uncached rate. The owner
must re-check the [official pricing page](https://api-docs.deepseek.com/quick_start/pricing/)
before each paid run; if rates or the model change, update the constants and
tests before enabling paid use. The proxy is a per-workflow-run ceiling; it
cannot constrain other clients using the same API account concurrently.

The audit artifact contains the per-run USD ceiling, actual USD charges or
conservative reservations, request counts, denied calls, token usage, failure
state, and whether reservations settled. It excludes prompts, API keys, and
account balance amounts. The workflow fails on API errors, no diff, disallowed
files, test failures, audit failures, or PR creation failures. Tests and PR
creation finish before any proposal is available for owner review. There is no
auto-merge, production deployment, or automatic follow-up run.

Only the programmer job receives repository write permissions. The Aider
process receives no GitHub token, cannot edit workflow files through its
explicit file list, and is not given the DeepSeek key. The repository setting
that allows `GITHUB_TOKEN` to create and approve pull requests is required for
the final PR action; it is a combined permission and must not be enabled without
owner authorization.
