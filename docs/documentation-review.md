# Documentation review

A review of the documents against the code they describe, made after the security, internationalisation and observability reviews and in the same manner: read every document and the code it names, test what can be tested here, fix what is this repository's to fix, and write down the rest. Its lasting part is a check in the test suite that keeps the documents true.

## Scope and method

The README, `docs/BUILD_STATUS.md`, `docs/DATABASE_SECURITY.md`, `docs/frontend-contract.md`, the design rationale, the security and observability reviews, the typeface README, the Replit agent's notes (`replit.md`) and the API contract (`lib/api-spec/openapi.json`); the doc comments on the shared schema, the console's libraries and the API's operational modules. For each document: does every path, command, endpoint and environment variable it names exist; is every environment variable the code reads documented; does a newcomer find what they need; is the spelling and the vocabulary one; and could any of this drift unnoticed.

## What is sound

- **The reviews and the rationale** carry their method, findings and status, so a later change is made against the same reasoning.
- **The contract** is the console's single source for records, pages and mutations, and the shared schema package the single source for statuses and catalogues, so the two cannot disagree by retyping.
- **Module headers** on the domain modules say which requirement each implements.
- **British spelling** in the console, as the contract requires, and the requirement codes used as written in the specification.

## Findings, and what changed

| # | Finding | Kind | Status |
| --- | --- | --- | --- |
| 1 | The generated API packages (`lib/api-zod/src/generated`, `lib/api-client-react/src/generated`) had been edited by hand for the health and readiness operations, although the README documents the generator that writes them. | Accuracy | **Fixed.** Regenerated from the contract with the documented command; the README now says the contract is generated and never edited by hand, and where a change starts. |
| 2 | The served contract had no summary or description on any of its 18 operations, described 3 of its 25 parameters and none of its 28 schemas, and was titled "Api". | Completeness | **Fixed.** Every operation, parameter and schema is described in the generator; the title is "Valo Pay sandbox API". The check refuses an undescribed operation. |
| 3 | The design rationale was named and titled for the landing and sign-in pages while it recorded every state and audit of the console; its list of files was the original two pages'. | Accuracy | **Fixed.** Renamed `docs/design/console.md`, retitled, its files listed. |
| 4 | The README had no index of the documents, no vocabulary (lender and merchant, workspace and sandbox, kobo, WAT), no guide to making a change, one 2,700-character sentence listing the console's tested flows, and sixty lines of Replit-specific publishing procedure. | Navigability | **Fixed.** A Documentation table, a Vocabulary section and a Making a change section; the tested flows as a list; the publishing procedure moved to `docs/github-sync.md` with a pointer left. |
| 5 | American spellings in prose (`behavior`, `authorization`, `authorized`, `initialize`, `serializes`) against the contract's British-spelling rule. | Consistency | **Fixed**, and the check refuses them in prose. |
| 6 | Of the shared schema package's 138 exports, 77 had no doc comment; the console's libraries and the API's operational modules had gaps of their own. | Code documentation | **Fixed** for the shared schema (every export documented, and the check keeps it so), the console's libraries and the API's store, exports, scheduler, packs and readiness modules. The domain internals (the policy engine, reconciliation, close and alerts modules) keep their module headers; their exported helpers are read with the tests that pin them. |
| 7 | A new document could be left out of a source upload: the snapshot tool carries a fixed list, and the security review was missing from it until the last change. | Drift | **Fixed.** The check requires every document under `docs/` to be on the list. |
| 8 | Nothing checked that a path, command or environment variable a document names exists, that a variable the code reads is documented, or that the contract lists every route and action. | Drift | **Fixed.** `scripts/check-docs.mjs`, below. |
| 9 | `scripts/src/hello.ts` is a scaffold with no purpose beyond satisfying the scripts package's TypeScript configuration. | Hygiene | **Left.** Removing it means changing that configuration; noted here so it is not mistaken for something. |
| 10 | `replit.md` repeats parts of the README for the Replit agent. | Duplication | **Left**, as the agent reads it; the check covers its paths, commands and spelling so it cannot drift silently. |

## The check

`node scripts/check-docs.mjs` runs with `pnpm run test:pure` and `pnpm test`. It reads the README, `replit.md`, every document under `docs/`, the typeface README, the contract and the code, and fails the suite when:

- a document names a repository path (other than a build output, which exists only after a build), links to a file, or names a `pnpm` script that does not exist;
- the code reads an environment variable the README does not mention, or the README's table documents one that nothing reads;
- an operation, parameter or schema of the contract has no description, or the contract keeps the generator's placeholder title;
- an export of `lib/valopay-schema` has no doc comment;
- a document under `docs/` is not on the snapshot tool's list;
- a console route or a domain action is missing from `docs/frontend-contract.md`, or the contract describes an action the code does not have;
- a route served by a router `app.ts` mounts under `/api`, whatever its variable is called and including the Paystack test ingress mounted outside `routes/index.ts`, is missing from the contract, or `app.ts` mounts something under `/api` the check cannot follow to a file under `routes/`;
- the prose of a document uses an American spelling from its list.

## Where to document what

- **What the application is and how to run, check and change it**: the README.
- **What this build delivers and does not**: `docs/BUILD_STATUS.md`, one line per capability.
- **A rule**: a doc comment where the rule lives in `lib/valopay-schema` or the domain, naming the requirement code; a golden case that pins it.
- **An API operation**: its summary and description in `scripts/create-valopay-spec.cjs`, then the regeneration.
- **A console behaviour**: `docs/frontend-contract.md`; the reasoning behind a design choice: `docs/design/console.md`.
- **A review** (security, observability, this one): its own document with findings and status, listed in the README's table and on the snapshot tool's list.
- **An operator's question**: `docs/observability.md`.

## How to re-run

`pnpm run test:pure` runs the check. `node scripts/create-valopay-spec.cjs && pnpm --filter @workspace/api-spec run codegen` regenerates the contract and its packages; a diff after that means a package was edited by hand.
