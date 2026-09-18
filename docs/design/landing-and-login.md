# Landing and sign-in pages: design rationale

This records why the landing page and the sign-in pages are the way they are, so the next change to them is made against the same reasoning rather than against taste. It follows the design-rationale practice from the interaction-design course notes: explain the decisions, keep the design knowledge, and make the discipline visible. The principles applied are Nielsen's ten usability heuristics, the visual foundations from the first interaction-design lecture (information hierarchy, Gestalt proximity, small multiples, white space, grids, asymmetric typography, greyscale first, one or two colours, animation sparingly, keep it simple), and the second lecture's Norman principles, Dix et al. usability principles, Shneiderman's eight golden rules and universal design.

Files: `artifacts/valo-pay/src/pages/landing.tsx`, `src/pages/sign-in.tsx`, `src/components/brand.tsx`, the brand and overview route in `src/components/layout.tsx`, `src/pages/not-found.tsx`, and the routing in `src/App.tsx`. Tests: `artifacts/valo-pay/tests/landing.test.tsx` and `tests/sign-in.test.tsx`.

## Who the pages are for

The visitor is the buyer the marketing strategy describes: a head of collections, a finance lead or a founder at a Nigerian lender that collects by direct debit. They arrive with five questions, in this order: What is this? Is it for me? What does it do, and what does it not do? What does it cost and is it safe? How do I get in? The landing page answers them in that order, top to bottom, so the information appears in the natural and logical order the visitor expects (Nielsen 2, information hierarchy).

The second reader is someone who already has a workspace and wants to sign in, and the third is a reviewer, regulator or partner who wants the boundary statements. The header serves the second reader in one click, and the "What we are, and what we are not" section serves the third without making the first reader scroll past it.

## The conceptual model on the page

Valo Pay is an operations layer that observes and records what the lender's aggregator and loan software do; it is not a wallet, a bank or a payment provider. The page carries that model in three places: the descriptor beside the name ("Collections operations layer"), the three steps of "How it works" (plug in, observe, instruct within the rules) with a beginning, middle and end, and the boundaries section that says what we are not before anyone has to ask.

The sandbox and the workspace are the same console. The sandbox is anonymous and synthetic; a workspace is the same console that remembers you. The page never blurs the two: "Open the sandbox" and "Sign in" are different words, different buttons and different addresses, and the helper line under the hero says the sandbox needs no sign-in.

## Information hierarchy and the visual foundations

- **The first three lines.** Line one is the descriptor ("A collections operations layer for lenders that collect by direct debit"), line two the promise (the H1), line three begins "We never hold money." The name says "Pay", so the marketing strategy requires the descriptor and that sentence in the first three lines, and the test pins them there.
- **One hierarchy of type.** One H1, one H2 per section, one H3 per card, and five sizes in all. Weight and size carry the hierarchy, so the page still reads in greyscale (design first in greyscale, then add colour).
- **Left-aligned, asymmetric layout.** Every block is left-aligned on a 72rem container. The hero is a three-to-two grid: words on the left, the daily-close figure on the right. Nothing is centred except when the page stacks to one column on a phone.
- **Grid and spacing.** The four jobs are a two-by-two grid, the three steps a row of three, the four boundaries two by two. Spacing comes from one scale (4, 8, 16, 24, 32, 56, 80 px) so gaps mean the same thing everywhere.
- **Proximity.** What belongs together sits together: the icon, title and text of a card; the two buttons and their helper line; the title and caption of the figure. Sections are separated by white space and an alternating card and page background, not by decorative dividers.
- **Small multiples.** The four jobs, the three steps and the four boundaries each use one identical card shape, so the only differences the eye finds are the content.
- **White space as an element.** Section padding is 56 to 80 px; the hero has no background image. The space does the grouping, which is why the page needs no lines between things.
- **Colour.** Two colours: the console's indigo for actions and icons, and the brand orange for the mark only. The orange fails the 4.5:1 text contrast on white, so it is never used for text (the comment on `--brand` in `index.css` says so). Green appears only as the console's own status colour, always beside a word, never alone.
- **Animation.** None. Buttons change colour on hover and focus; nothing moves, slides or fades in. Animation draws the eye, and on this page the eye should be on the words.
- **Keep it simple.** Every link says where it goes: "Open the sandbox", "Sign in", "See how it works", "Back to the start". No "Learn more", no "Get started", no icon-only buttons.

## Nielsen's ten heuristics

| Heuristic | Where it shows |
| --- | --- |
| 1. Visibility of system status | The status chip "Stage 1 · observation mode · no live instructions"; the figure's "Scheduled 07:00 WAT · ran on time"; the sign-in page says whether sign-in is available on this host; the console's sandbox banner appears the moment the sandbox opens. Every region waiting for the API shows one status line naming what is coming, and every button whose action is in flight says what it is doing and cannot be pressed again. |
| 2. Match between system and the real world | Mandates, instalments, settlements, aggregators, NIBSS, WAT, exact naira amounts. British spelling. No "leverage", "seamless" or "solution". |
| 3. User control and freedom | Visiting creates nothing: no sandbox, no cookie, no request to the API until "Open the sandbox" is chosen. Every page has "Back to the start". The sign-in page offers the sandbox without an account. A skip link comes first in the tab order. |
| 4. Consistency and standards | One brand lockup on the landing page, the sign-in pages and the console sidebar. The console's own `Button` and status chip. Clerk's form themed to the console's tokens. One primary button per screen. |
| 5. Error prevention | No form is shown where sign-in cannot work. The sandbox is offered before an account is asked for. When already signed in the header reads "Open your workspace" instead of "Sign in". |
| 6. Recognition rather than recall | Section links in the header. The figure shows the product's daily close instead of describing it. The two ways in are repeated at the end of the page so nobody scrolls back. The sign-in page lists what signing in changes. An empty list says what would be there, why it is empty now and where it comes from, so nobody has to remember how the console fills. |
| 7. Flexibility and efficiency of use | Skip link, in-page anchors, both ways in within one click of the header for a returning visitor, keyboard reachable in reading order. |
| 8. Aesthetic and minimalist design | One illustration, one H1, no testimonials, logos, carousel or chat widget. Each section answers one of the five questions. The sign-in page carries three lines of context, not a marketing column. |
| 9. Help users recognise, diagnose and recover from errors | The unavailable-sign-in card says what is missing (a Clerk key on this host), why, and what to do. The not-found page shows the address it looked for so a typo can be seen, says nothing changed, and offers two ways out; a customer page whose record the lender does not have says so inside the console, with the sidebar as the way out. A page that stops working says so in plain words, that no record is changed by it, shows the time and the address for a report and keeps the sidebar; the error's message is shown in development only. Clerk's own error text is plain language. A search or filter with no matches says so with the term it looked for, as a status, instead of pretending the list is empty. |
| 10. Help and documentation | Footer links to how the sandbox works and to the security boundary. The sign-in aside is the help for the one decision made there. |

## Norman's principles

- **Visibility and discoverability.** The ways in are visible in the header, the hero and the end of the page. No hamburger menu holds the only way in; on a phone the header keeps Sign in, and the hero's Open the sandbox is in the first screen.
- **Affordance and signifiers.** Buttons look like the console's buttons and links look like links. The daily-close figure is drawn as the console's own close card, so a visitor recognises the product before opening it.
- **Mapping.** The three steps are numbered in the order they happen. "See how it works" scrolls to "How it works".
- **Feedback.** Hover and focus states on every control; the page title changes per page; when the sandbox opens the banner and the lender selector confirm where you are.
- **Constraints.** There are two actions, and neither can move money or change a record. The text says so.
- **Knowledge in the world.** The four jobs, the price and the boundaries are on the page rather than behind a form or in a deck.
- **Simplify the task structure.** Opening the sandbox is one click and needs no account; signing in is one form with no wizard around it.

## Dix et al.: learnability, flexibility, robustness

- **Learnability.** Predictability: each link's label is its destination. Synthesisability: the title and address change on every page, and the console's banner confirms the state. Familiarity: the words are the lender's own. Generalisability: the sign-in shell reuses the console's card, button and status chip, so what is learnt on one page applies to the next. Consistency: one lockup, one action colour, one voice.
- **Flexibility.** Substitutivity: two equivalent ways in, and the sandbox is reachable from the sign-in page as well as the landing page. Customisation lives inside the console's settings, not on these pages.
- **Robustness.** Observability: the status chips, and the figure labelled as an illustration. Recoverability: "Back to the start" on every page and a not-found page inside the console. Responsiveness: the pages are static, fetch nothing and load no late images, so they render before the API answers and never shift layout. Task conformance: the two tasks a visitor has, to read and to get in, are both complete on the page.

## Shneiderman's eight golden rules

Consistency (the same terms on the landing page, the sign-in pages and the console: sandbox, workspace, lender); shortcuts (skip link, anchors, header actions); informative feedback (focus rings, hover states, the console's banner on arrival); closure (how it works has a beginning, a middle and an end, and the page ends with the two ways in); simple error handling (the unavailable-sign-in card, the not-found page); easy reversal (leaving the sign-in page costs nothing, and a sandbox is disposable: removed after 30 days without a change); internal locus of control (nothing plays, scrolls or creates itself; the visitor opens the sandbox); reduced short-term memory load (the sign-in page repeats what signing in changes, the ways in repeat, and there is no multi-step flow).

## Universal design

- **Equitable.** The sandbox needs no account and costs nothing to look at.
- **Perceptible.** Text is the console's indigo on white (about 14:1) or the muted grey (about 4.9:1); the brand orange is never text. Status is carried by words as well as colour. Icons are hidden from assistive technology and always paired with text. Landmarks: header, a labelled section nav, main, aside, footer; headings in order; a `figure` with its caption; the steps are an ordered list whose headings read "Step 1" to a screen reader.
- **Simple and intuitive.** Plain words, short sentences, one idea per line.
- **Tolerance for error.** Nothing on these pages is destructive or irreversible.
- **Low physical effort.** Everything works by keyboard in reading order; buttons are at least 36 px high; no drag, hover-only or timed interaction.
- **Size and space.** One column below 640 px, the hero stacks, type never goes below 12 px, and the figure's numbers are tabular so they align. At 200% zoom the page becomes the single-column layout.

## The sign-in page

Clerk's form is themed rather than rebuilt. It already handles every strategy the account is configured with, its error messages are plain language, and its labels stay visible. Rebuilding it would add a second place where account errors are worded and risk a form that looks like sign-in but is not one. The theming (`appearance` in `sign-in.tsx`) passes the console's indigo, radius and typeface, so the form belongs to the page.

The page's own contribution is context: the heading says what the form is for ("Sign in to your workspace"), the aside says what signing in changes, and "We never hold money" is repeated because a shared sign-in link can be the first page a visitor ever sees. A link to the sandbox without an account sits under the form for the visitor who only wanted to look.

Where this host has no Clerk key there is no account to sign into. The old console redirected `/sign-in` to `/` in that case, which reads as a broken link. The page now says sign-in is not available on this host, says why, and offers the sandbox, instead of a form that could not work (Nielsen 1, 5 and 9). After sign-in Clerk sends the visitor to `/overview`.

## Routing

The landing and sign-in pages are routed outside the console's workspace provider (`App.tsx`). Visiting `/`, `/sign-in` or `/sign-up` therefore sends no request to the API and creates no sandbox; the workspace request happens only when someone opens the console. The overview moved from `/` to `/overview` to make room, and the console's brand lockup links back to `/`. `App.tsx` keeps one list of the console's addresses and mounts the console only for those, so an address it has no page for is answered outside the provider too: a mistyped address or a stray crawler creates no sandbox.

## Not found

There are two not-found states, and they are different pages because the visitor's situation is different. An address the console has no page for gets the public frame (the same header as the sign-in pages), the address it looked for shown exactly so a typo can be seen, a sentence that nothing changed, and two ways out: the overview and the start. It fetches nothing, so it renders at once and creates nothing. A customer address whose record the current lender does not have is a page that exists with a record that does not, so it stays inside the console with the sidebar and the lender selector, names the reference it looked for, says the customer may belong to another lender in the workspace, and links back to the customer list. Neither state shows a code or a stack trace, and each sets a page title that says what happened (Nielsen 1 and 9, Dix recoverability, Shneiderman's simple error handling).

## Errors

When a page throws, the console does not go blank and does not show a developer's message. The boundary inside the console layout catches it, so the sidebar and the lender selector stay as the way out, and the page area shows the same notice card as the not-found states with `role="alert"` so it is announced; the page title says "Page error" while the notice is up. It says what happened (the page stopped working), what it means (an error on a page changes no record, and the audit log holds the result of any action just confirmed), what to report if it happens again (the time and the address, shown exactly), and two ways on: Try again, which re-renders the page, and the overview, as a plain link so it starts afresh. The old fallback said "This part of the app hit an error" in grey outside the design system and printed nothing a lender's staff could act on. The error's own message can carry an API response or another internal, so it is folded away under "Technical details" in development and not rendered in production. Boundaries outside the console (the router and the root) show the same notice in the public frame, and navigating to another address clears a caught error, so a broken page never traps the visitor (Nielsen 3 and 9, Dix recoverability, Shneiderman's simple error handling and easy reversal). The not-found states and the error notice share one card, `components/notice.tsx`, so every such moment reads the same way.

When the workspace itself cannot be loaded, nothing in the console can work, so the notice replaces the pages rather than sitting inside them, in the same frame and card. The words follow the situation instead of one catch-all sentence: when the service asks the visitor to wait (a new sandbox refused by the per-address limit, or the request limit), its own plain-language message is passed on; when there is no answer, the page says the console could not reach the service and to check the connection; when the service hit an error, it says so and gives the time for a report, and keeps the body's wording to itself because a 5xx can carry internals. Every version says that no lender data has been changed. Try again shows its own progress ("Trying again…", disabled) so a click is seen to do something, and the frame keeps the start and, where sign-in exists, sign-in as the other ways on. The old state was one centred sentence with a retry button and no way out. Before the workspace arrives, the page area says "Loading your workspace…" as a status rather than showing pages with nothing in them (Nielsen 1: visibility of system status; 9; Dix: observability and recoverability; Shneiderman: informative feedback).

## Loading and waiting

Waiting is a state like any other, so it is said, not left blank. Every region that waits for the API shows one status line, `Loading <what>…`, that names what is coming ("Loading the overview…", "Loading due items…"), left-aligned in the space the content will take, with `role="status"` so it is announced once. The only motion on the page is the small spinner beside it, and it stops under reduced motion. A table that is waiting says so in its own row, so the header and the columns are already in place. Before this the console had five wordings across twenty-two places ("Loading...", "Generating reports..." for a fetch, "Loading audit logs..."), three paddings, centred text, an optional pulse and no status role.

No skeletons. A line of words is simpler, the same everywhere, honest about how long it may take, and it never pretends to know the shape of what is coming; a pulse of grey boxes is animation that draws the eye for no information (animation sparingly; keep it simple).

A button whose action is in flight is disabled, `aria-busy`, and its label says what is happening beside a spinner: Saving…, Generating…, Verifying…, Running the engine…, Closing the day…, Trying again…. This is one property of the button (`busy` with `busyLabel`) rather than a ternary rewritten in each page, so the feedback is the same everywhere and the click cannot be repeated while it runs. Where several buttons share one action, such as the dispute pack's PDF, CSV and JSON, only the one that was pressed says it is generating and the others wait, disabled (Nielsen 1: visibility of system status; Dix: responsiveness and observability; Shneiderman: informative feedback; universal design: perceptible information, reduced motion).


## Empty states

An empty list is a message, so it says three things in order: what would be here, why it is empty here and now, and what to do next when there is something to do. "No proposals waiting for review" is followed by what a proposal is and that running the engine looks for new ones; "No mandates yet" says where mandates come from and offers the sandbox's own way to create one; "No daily close yet" points at the button above and the scheduled close. The words are the lender's (instalment, mandate, settlement batch, notice) and every state that has a rule behind it names the rule (REC-09, BIL-01, MEA-05), so the empty state also teaches how the console fills. Before this there were about twenty-six of them with mixed wording ("Log empty", "No authorizations found for this workspace", "No close snapshots available."), centred, some with a large faded icon, and none said what to do.

"Nothing yet" and "nothing matches" are different situations. A search or a filter with no results is the outcome of what the visitor just did, so it says so with the term it looked for ("No customers match “zzzz”", "Nothing resolved yet"), suggests how to widen it, and carries `role="status"` so it is announced; a list that is genuinely empty is not announced, because nothing happened. The customers and audit pages used to show "No customers found" and "Log empty" for both.

One component, `components/empty-state.tsx`, with a table-row form, left-aligned in the space the content will take, without an illustration: the words are the information, and a faded icon adds nothing a reader can act on (Nielsen 1, 2, 6 and 9; Norman: knowledge in the world; Dix: observability; Shneiderman: closure; keep it simple).


## What we left out, on purpose

- No hero animation, video, carousel, chat widget or cookie banner. No cookie is set until the sandbox is opened, and that cookie is the sandbox session itself.
- No testimonials, logos or numbers we have not measured. The recovery uplift is not on the page because Test 2 has not been proven; every number shown carries its basis, and the daily-close figure is labelled as an illustration with synthetic figures.
- No "fully compliant", "leading" or "seamless". Regulators are named specifically and the wording is "written to".
- No lead-capture form. The ways in are the sandbox and sign-in.
- No separate marketing palette. The pages use the console's own tokens so the product looks the same before and after the door.

## How to check a change

Automated: `pnpm --filter @workspace/valopay run test` pins the first three lines, the link addresses, the skip link, the unavailable-sign-in state, the not-found title and that visiting `/` or `/sign-in` makes no API request.

Manual, before merging a change to these pages: a keyboard-only pass (tab order follows reading order, focus is visible, the skip link comes first); 375 px width and 200% zoom with no horizontal scroll; the screen reader's landmark list reads header, navigation "Sections", main, complementary, contentinfo; a greyscale view in which the hierarchy survives; any new colour used for text checked at 4.5:1 or better against its background; and every number on the page still carrying its basis.
