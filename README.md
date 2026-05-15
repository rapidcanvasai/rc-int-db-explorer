# DB Explorer

A lightweight, DataGrip-style web UI for browsing read-only MySQL databases. FastAPI backend + React (Vite + CodeMirror 6) frontend. Deploys to **any RapidCanvas tenant** as a FastAPI + DataApp pair, or runs fully locally against a Docker MySQL.

```
┌───────────────────────────────────────────────────────────────────┐
│  DB Explorer   [DEV]   app_db                              ☾    │
├───────────────┬───────────────────────────────────────────────────┤
│ Tables History│  ── Results ──                                    │
│ ▼ users       │  ┌───────┬─────────┬─────────────┐                │
│   ▼ columns   │  │ id    │ email   │ created_at  │                │
│     ⚿ id      │  │ 1     │ a@b.com │ 2026-…      │                │
│     • email   │  │ 2     │ c@d.com │ 2026-…      │                │
│ ▼ orders      │  └───────┴─────────┴─────────────┘                │
│   …           ├───────────────────────────────────────────────────┤
│               │  Query 1  Query 2  +                       ▶ Run  │
│               │  SELECT email FROM users WHERE id > 100;          │
│               │                                                   │
├───────────────┴───────────────────────────────────────────────────┤
│ ● app_db@db.host  DEV  · tables: 12 · last: 80 rows / 0.012s     │
└───────────────────────────────────────────────────────────────────┘
```

## Features

- **A–Z table tree** with automatic prefix grouping (`users_*`, `orders_*`), collapsible sections, columns + indexes inline.
- **SQL editor** — CodeMirror 6 with MySQL dialect, dark/light theme, Tab indent.
- **Smart autocomplete** — context-aware:
  - After `FROM` / `JOIN` → tables only
  - After `SELECT` / `WHERE` / `ON` / `HAVING` → columns from the FROM/JOIN tables of the current statement
  - After `alias.` → that table's columns only
  - Snippets (`selstar`, `cnt`, `joinon`) and MySQL functions (`COUNT`, `DATE_FORMAT`, …)
  - Refresh button re-fetches schema metadata without reload
- **Tabbed query editor** — multiple named tabs, per-tab results, `Cmd+T` new, `Cmd+W` close, `Cmd+1‥9` jump. Persisted to localStorage.
- **Query history** — last 100 queries with timing, one click to re-run.
- **Dark mode** + draggable sidebar/editor splits, persisted.
- **Read-only by design** — only `SELECT`, `SHOW`, `DESCRIBE`, `EXPLAIN` are allowed by the backend. Destructive ops (`DELETE` / `DROP` / `TRUNCATE`) are gated behind a feature flag + confirmation modal (see [Destructive operations](#destructive-operations-opt-in)).
- **Env identification** — a bold `LOCAL` / `DEV` / `PROD` badge in the header so it's hard to confuse environments.

## Quickstart (local)

Prereqs: Python 3.10+, Node 18+, Docker (only if you want the bundled MySQL).

```bash
make setup     # venv, pip install, npm install, write a default .env
make db-up     # optional: local MySQL on :3307 via docker-compose
make dev       # backend on :8001 + frontend on :5174
```

Open <http://localhost:5174>.

To point at your own MySQL, edit `app/.env`:

```dotenv
APP_ENV=LOCAL
MYSQL_HOST=your.host
MYSQL_PORT=3306
MYSQL_USER=readonly_user
MYSQL_PASSWORD=…
MYSQL_DATABASE=your_db
# or, single line:
# MYSQL_CONN_STR=mysql://user:pass@host:3306/db
```

## Deploy to RapidCanvas

The repo deploys as a **FastAPI app** (backend) + **DataApp** (frontend) inside any RapidCanvas tenant. Two configs let you keep `dev` and `prod` targets side by side.

### 1. Provision the apps once per environment

In your RapidCanvas tenant:

- Create a **FastAPI app** (any name).
- Create a **DataApp** (ReactJS) and link it to the FastAPI app you just made.
- Copy each app's UUID.

Do this twice if you want both `dev` and `prod` targets.

### 2. Fill in the deploy configs

```bash
cp infra/.rapidcanvas.example       infra/.rapidcanvas        # prod
cp infra/.rapidcanvas.dev.example   infra/.rapidcanvas.dev    # dev
cp app/.env.dev.example  app/.env.dev
cp app/.env.prod.example app/.env.prod
```

Edit each `infra/.rapidcanvas*` with your tenant's `API_HOST`, `FASTAPI_ID`, `DATAAPP_ID`.
Edit each `app/.env.*` with the MySQL connection that env should hit.

### 3. Deploy

Export your RapidCanvas API key (or pass it inline):

```bash
RAPIDCANVAS_API_KEY=rc-…  ./infra/deploy-backend.sh  dev
RAPIDCANVAS_API_KEY=rc-…  ./infra/deploy-frontend.sh dev

RAPIDCANVAS_API_KEY=rc-…  ./infra/deploy-backend.sh  prod
RAPIDCANVAS_API_KEY=rc-…  ./infra/deploy-frontend.sh prod
```

Each script zips the relevant tree, uploads via signed URL, and triggers a launch. The frontend script also wires `VITE_API_URL` to the matching FastAPI's public URL automatically.

## Make targets

| command       | what it does                                            |
|---------------|---------------------------------------------------------|
| `make setup`  | Create `.venv`, install Python + npm deps, scaffold env |
| `make dev`    | Start backend (:8001) + frontend (:5174) together       |
| `make backend`| Backend only (`python run.py`)                          |
| `make frontend` | Frontend only (`npm run dev`)                         |
| `make db-up`  | Start local MySQL via `docker compose` (:3307)          |
| `make db-down`| Stop local MySQL                                        |
| `make reset`  | Remove `.venv` and `node_modules`                       |

## Repository layout

```
app/                   FastAPI backend (read-only MySQL JSON API)
  main.py
  .env.example
  .env.dev.example
  .env.prod.example
dashboard/             Vite + React + CodeMirror frontend
infra/
  deploy-backend.sh    dev|prod backend deploy to RapidCanvas
  deploy-frontend.sh   dev|prod frontend deploy to RapidCanvas
  .rapidcanvas.example
  .rapidcanvas.dev.example
scripts/
  bootstrap.sh         first-time local setup
  dev.sh               concurrent backend + frontend runner
docker-compose.yml     bundled MySQL for local dev
Makefile
```

## Destructive operations (opt-in)

`DELETE`, `DROP`, and `TRUNCATE` are disabled by default. Flip them on per environment by setting `DESTRUCTIVE_OPS_ENABLED=true` in the matching `app/.env.*` file (`true` / `1` / `yes` all work).

When enabled, the backend exposes:

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/query` | Now accepts `DELETE` / `DROP` / `TRUNCATE` in addition to read-only verbs. Response includes `kind: "destructive"` and `affected_rows`. |
| `DELETE` | `/api/tables/{name}` | `DROP TABLE \`name\``. |
| `DELETE` | `/api/tables/{name}/rows` | `DELETE FROM \`name\` [WHERE …]`. JSON body `{"where": "id = 42"}` is optional; omitting it deletes every row. Semicolons in `where` are rejected. |

`/api/info` exposes `destructive_ops_enabled` so the UI only renders the affordances the backend actually honours.

**The UI never sends a destructive request silently.** Every path — the trash icon on a sidebar row, and any destructive SQL typed into the editor — opens a red `ConfirmDangerModal` that requires the user to type the table name (drops) or the literal `DELETE` (queries) before the destructive button enables.

Defense in depth (recommended):

1. Keep the flag off in environments you never want to mutate.
2. Use a DB user with only the privileges you want exposed (e.g., grant `DELETE` on specific tables, withhold `DROP` entirely).
3. Audit usage at the DB level — every destructive call is a normal MySQL statement.

## Safety

- The backend rejects anything other than `SELECT`, `SHOW`, `DESCRIBE`, `EXPLAIN` (see `app/main.py` → `validate_query_allowed`). With `DESTRUCTIVE_OPS_ENABLED=true`, `DELETE` / `DROP` / `TRUNCATE` are additionally allowed — every other verb (`INSERT`, `UPDATE`, `ALTER`, `GRANT`, …) is still rejected. Use a least-privilege DB user in addition for defense in depth.
- Real secrets never live in git — see `.gitignore`. Templates end in `.example`.

## Tests

```bash
pip install -r requirements-dev.txt
pytest tests/
```

Covers the destructive-ops flag gate at `/api/query` and the dedicated endpoints, identifier and `WHERE`-clause sanitization, and the SQL classifier.

## License

MIT. See [LICENSE](LICENSE).
