# Reservations mission plan

This folder is a snapshot of the multi-agent mission that built the Reservations
module on branch `pr/reservations`. It holds the plan, the acceptance contract,
the worker instructions and the validation reports. It is not product code.

The same snapshot lives in `docs/reservations-mission/` and `.factory/mission/`.

## Status at snapshot time

| Milestone                          | State                                           |
| ---------------------------------- | ----------------------------------------------- |
| `foundation`                       | Validated                                       |
| `foh-core`                         | Validated                                       |
| `guest-channels-and-crm`           | Validated (scrutiny and 3 user-testing rounds)  |
| `payments-integrations-and-native` | Not started: 4 pending features, 175 assertions |

`validation-state.json`: 310 assertions passed, 175 pending, 0 failed.

## What is here

| Path                     | Purpose                                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `mission.md`             | The approved mission proposal (scope, milestones, testing strategy)                                                                  |
| `architecture.md`        | Authoritative architecture: components, data flow, invariants                                                                        |
| `validation-contract.md` | 485 `VAL-*` behavioural assertions that define "done"                                                                                |
| `validation-state.json`  | Pass/pending status of each assertion                                                                                                |
| `features.json`          | Ordered feature list. Pending features are the remaining work; each has `fulfills` (assertion ids it completes) and carry-over notes |
| `AGENTS.md`              | Mission rules for workers: boundaries, conventions, testing guidance                                                                 |
| `services.yaml`          | Commands (install, typecheck, lint, test gates) and dev services with ports                                                          |
| `init.sh`                | Idempotent environment setup run before each worker session                                                                          |
| `skills/`                | Per-worker-type procedures (backend, app-ui, sites, payments, native, docs, domain)                                                  |
| `library/`               | Accumulated knowledge: engine notes, UI/Sites patterns, user-testing recipes                                                         |
| `scripts/`               | Gate scripts (typecheck, lint, test) and helpers such as `set-org-flag.sh`                                                           |
| `research/`              | Raw research notes gathered during planning                                                                                          |
| `validation/`            | Scrutiny and user-testing synthesis reports per milestone                                                                            |
| `handoffs/`              | Worker handoff records (what each worker did, verified and left open)                                                                |

Not included: screenshots and HAR evidence (212 MB), worker transcripts and
runtime state.

## Paths

The files were written for a sandbox where the repository lived at
`/Users/zama/menuza` and the mission folder at
`/Users/zama/menuza/.factory/mission`. Replace those prefixes with your local
repository path and this folder when you run commands from `services.yaml` or
`scripts/`.
