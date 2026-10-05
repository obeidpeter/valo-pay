# UI contract

The current implementation uses server-rendered Django templates and bundled
static assets. Preserve accessible headings, labelled forms, keyboard controls,
responsive tables, text status labels and same-origin CSRF.

## Routes and identity

- `/`: public product landing page.
- `/demo/`: intentional synthetic entry; `/demo/start/` requires POST.
- `/today/`: Dashboard (route retained despite the display-name change).
- Six primary navigation entries: Dashboard, Customers, Collections, Pay-by-bank,
  Reviews and Reports. Settings and previews remain in the Account menu.
- `/demo/guide/`: ten-step guide. POST `/demo/guide/action/` opens a server-generated
  tenant-scoped target and selects a sample role; it does not perform the action.
- POST `/demo/guide/end/`: ends the tour without deleting the demo.
- POST `/demo/debits/run/`: eligible synthetic sessions only, never staff or real
  records. Every outcome and message must say it is a simulation.
- `/demo/restart/`: explicit confirmation detaches the old sample workspace without
  deleting its records.
- `/access/login/` and related access routes: separate staff identity, mandatory
  authenticator verification and membership controls.

Do not relax authentication, financial approval or provider-verification gates to
match an older demo template. Do not infer payment success from browser actions.
State labels such as Unknown, Failed and In progress retain their distinct meaning.
No deletion, automatic retry, provider delivery or live-service claim may be added
unless the corresponding approved behavior actually exists.

The source templates, forms and views define field names and context variables.
Historical files under docs/content are references, not a current runtime contract.
