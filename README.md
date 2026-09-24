# Environmental Data Explorer

A map viewer for the Antapacay environmental datasets. It starts with the sediment
database: filter by element, quality and period, draw areas, open any sample, run
SQL, and ask questions to an assistant that answers with numbers, maps and charts.

Everything runs in the browser. There is no backend: the page is static, DuckDB-Wasm
reads the Parquet release straight from Hugging Face, and the assistant calls the
Claude API from the page. It is meant to be published with GitHub Pages.

## Run it locally

```bash
./scripts/sync-data.sh
./scripts/serve.sh
```

`sync-data.sh` downloads the release pinned in `config/datasets.json` into `data/`
using your own `hf auth login` (the folder is ignored by git). When that folder is
present and the page is opened on localhost, it is used instead of Hugging Face, so
no token is needed while developing.

Open http://127.0.0.1:8890 and sign in with the shared account.

## Accounts and keys

There is no server to check passwords, so the account works like a locked box.
`credentials.json` holds the Hugging Face token encrypted with a key derived from
`user:password` (PBKDF2, AES-GCM). Signing in decrypts it in the browser and keeps it
for the session. The password is shared by hand and never written in the repository.

To create or replace the account:

```bash
printf "Hugging Face token: "; read -rs HF_TOKEN; echo
export HF_TOKEN
node scripts/make-credentials.mjs <user> <password>
```

The assistant has no shared key: each person adds their own Anthropic key with the key
button, it stays in their browser and their usage is billed to them. The script can
also store one (`ANTHROPIC_API_KEY`) for a demo, and then every signed-in visitor spends
from it.

Anyone who knows the password can recover the token, and a weak password can be
guessed offline from the public file. So use a fine-grained Hugging Face token with
read access only, and a long random password.

## Publish on GitHub Pages

Push this folder to a repository, then in Settings > Pages choose "Deploy from a
branch", `main`, folder `/ (root)`. `.nojekyll` is already there. The page has no
build step, so every push to `main` is live after a minute.

## Configuration

`config/datasets.json` describes each dataset: Hugging Face repository and revision,
the Parquet tables, the projection of the coordinates, parameter labels and the
reasons shown for excluded results. Releases are pinned by tag; to move to a new
release, change `revision` and run `sync-data.sh` again.

A second dataset with the same release layout can be added as another entry and
opened with `?dataset=<id>`.

`config/assistant.json` sets the Claude model, effort, output limit and the maximum
number of tool steps per question. It runs Claude Opus 5 at `high` effort: answers
matter more than their price, a question costs a few cents. `effort: "medium"` is the
first knob if it feels slow; `claude-sonnet-5` at `medium` costs about a third. With Opus
and Fable models `fallbacks: "default"` lets the API answer with another model when
their safety filters decline a request; set it to `null` for Sonnet. `pricePerMTok`
holds the model's prices in dollars per million tokens, used to log what each question
cost in the browser console. Update it when you change the model.

## Links that keep the view

The address bar always reflects the current view, so a link opens the same map:

| Parameter | Values |
|---|---|
| `element` | a parameter code such as `cu`, `zn`, `as`, or `all` |
| `quality` | `VALID` (default), `all`, `PENDING_REVIEW`, `EXCLUDED_FROM_ANALYSIS` |
| `years` | `2010-2026` |
| `view` | `data` (default) or `assistant` |
| `basemap` | `light`, `topo`, `satellite` |
| `mode` | `points`, `density`, `clusters` |

## The assistant

The assistant does not write every query from scratch. Each kind of question has a
named metric in `src/data/metrics.js` whose SQL was checked by hand: what the data
covers and how reliable it is, summaries and distributions, where values are highest,
the most affected area and how values fade with distance from it, tailings, mine works
and rivers, upstream against downstream, agency reports against company monitoring,
values above a guideline the user gives, trends at the same stations, wet against dry
season, element comparisons and families, and station profiles and histories. Simple
questions take one call; whether the mine affects the sediments is built from several.
It falls back to read-only SQL, `draw_map` and `create_chart` when nothing fits.

Maps come in two kinds: one element through the explorer's own layers, with the same
colours, P99 pulse and legend, or a thematic map of any value per station (how many
metals exceed their P95, a trend, a ratio) with its own legend. The bar above the map
says what it shows. Charts are drawn with Chart.js in the conversation, on a log scale
where concentrations need it and with amber and red for values above the dataset P95
and P99.

The system prompt is `ASSISTANT.md` from the dataset release plus the notes in
`src/assistant/prompt.js`. The guide and the tools are cached by the API and shared by
every chat, so after the first question they cost a tenth of the normal input price.

Browsers that support WebMCP (`navigator.modelContext`) get the same tools, so an
agent in the browser can query the data without reading the screen. `llms.txt`
describes the site for agents that do read it.

## Checking the assistant

`evals/questions.json` holds the base questions whose answers were computed with
DuckDB beforehand: the numbers the answer must contain, the tools the assistant should
reach for, and a note on what to read by eye. With an API key added in the assistant,
run them from the browser console on the local site:

```js
const { runEvals } = await import("/evals/run.js");
await runEvals();
```

It asks every question in a fresh chat, prints what passed and what each one cost, and
puts the page back as it was. A full run costs one or two dollars with Claude Opus 5, so
pass a few ids to check one kind of question. Run it again after changing the model, the
effort or the prompt.

## Layout

```
index.html            page markup
config/               datasets and assistant settings
src/main.js           start-up order
src/state.js          shared state
src/url-state.js      view <-> address bar
src/auth/             sign-in and credentials.json
src/data/             DuckDB, selection filters, statistics, metrics
src/map/              MapLibre map, layers, drawn areas, popups, upstream catchments
src/panel/            side panel: filters, table, record, legend
src/assistant/        Claude client, prompt, tools, chat, charts, WebMCP
src/lib/              small helpers (formatting, SQL, geometry, markdown)
styles/               one stylesheet per area of the page
scripts/              local server, data sync, credentials
evals/                base questions to check the assistant
```

Libraries are loaded from jsDelivr through the import map in `index.html`.
