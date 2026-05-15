"""DB Explorer — read-only JSON API for browsing a MySQL database.

Local dev: see README.md (make dev).
Deploy:    see infra/deploy-backend.sh (RapidCanvas FastAPI dataapp).
"""

import logging
import os
import re
import time
from contextlib import asynccontextmanager, contextmanager
from typing import Optional
from urllib.parse import urlparse

from mysql.connector import Error as MySQLError, pooling
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

load_dotenv()

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Database configuration
# ---------------------------------------------------------------------------

def parse_mysql_conn_str(conn_str: str) -> dict:
    s = conn_str.strip()
    if not re.match(r"^mysql", s, re.IGNORECASE):
        s = "mysql://" + s
    s = re.sub(r"^mysql\+\w+://", "mysql://", s)
    parsed = urlparse(s)
    return {
        "host": parsed.hostname or "127.0.0.1",
        "port": parsed.port or 3306,
        "database": (parsed.path or "").lstrip("/") or "app_db",
        "user": parsed.username or "connector",
        "password": parsed.password or "",
    }


def get_db_config() -> dict:
    conn_str = os.getenv("MYSQL_CONN_STR", "")
    if conn_str:
        return parse_mysql_conn_str(conn_str)
    return {
        "host": os.getenv("MYSQL_HOST", "127.0.0.1"),
        "port": int(os.getenv("MYSQL_PORT", "3307")),
        "database": os.getenv("MYSQL_DATABASE", "app_db"),
        "user": os.getenv("MYSQL_USER", "connector"),
        "password": os.getenv("MYSQL_PASSWORD", "localtest"),
    }


DB_CONFIG = get_db_config()


def _env_flag(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


# Feature flag — when on, the API exposes DELETE/DROP affordances.
# Always require an explicit opt-in; the UI will still demand user confirmation.
DESTRUCTIVE_OPS_ENABLED = _env_flag("DESTRUCTIVE_OPS_ENABLED", default=False)

# Lazy pool — created on app startup, not at import time
_pool = None


def _get_pool():
    global _pool
    if _pool is None:
        _pool = pooling.MySQLConnectionPool(
            pool_name="explorer",
            pool_size=3,
            charset="utf8mb4",
            connect_timeout=10,
            **DB_CONFIG,
        )
    return _pool


@contextmanager
def get_cursor(dictionary=True):
    try:
        conn = _get_pool().get_connection()
    except Exception as e:
        logger.error(f"Failed to get DB connection: {e}")
        raise HTTPException(status_code=503, detail=f"Database unavailable: {e}")
    try:
        cur = conn.cursor(dictionary=dictionary)
        try:
            yield cur
        finally:
            cur.close()
    finally:
        conn.close()


@contextmanager
def get_connection():
    """Like get_cursor but exposes the connection so callers can commit()."""
    try:
        conn = _get_pool().get_connection()
    except Exception as e:
        logger.error(f"Failed to get DB connection: {e}")
        raise HTTPException(status_code=503, detail=f"Database unavailable: {e}")
    try:
        yield conn
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Read-only SQL guard
# ---------------------------------------------------------------------------

READONLY_PREFIXES = ("select", "show", "describe", "desc", "explain")
DESTRUCTIVE_PREFIXES = ("delete", "drop", "truncate")


def _first_word(sql: str) -> str:
    stripped = sql.strip().rstrip(";").strip()
    parts = stripped.split()
    return parts[0].lower() if parts else ""


def classify_query(sql: str) -> str:
    """Return 'readonly', 'destructive', or 'other' for the SQL's first keyword."""
    word = _first_word(sql)
    if word in READONLY_PREFIXES:
        return "readonly"
    if word in DESTRUCTIVE_PREFIXES:
        return "destructive"
    return "other"


def validate_query_allowed(sql: str):
    kind = classify_query(sql)
    if kind == "readonly":
        return kind
    if kind == "destructive":
        if not DESTRUCTIVE_OPS_ENABLED:
            raise HTTPException(
                status_code=403,
                detail=(
                    "Destructive queries are disabled. Set DESTRUCTIVE_OPS_ENABLED=true "
                    "on the backend to allow DELETE/DROP/TRUNCATE."
                ),
            )
        return kind
    raise HTTPException(
        status_code=403,
        detail=(
            "Only SELECT/SHOW/DESCRIBE/EXPLAIN are allowed"
            + (" (plus DELETE/DROP/TRUNCATE when enabled)." if DESTRUCTIVE_OPS_ENABLED else ".")
            + f" Got: {_first_word(sql).upper() or '<empty>'}"
        ),
    )


# ---------------------------------------------------------------------------
# FastAPI app with lifespan (lazy pool init)
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Try to init pool on startup, but don't crash if DB unreachable
    try:
        _get_pool()
    except Exception as e:
        logger.warning(f"DB pool init deferred: {e}")
    yield
    # Cleanup
    global _pool
    _pool = None


app = FastAPI(title="DB Explorer", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# RC lifecycle endpoint
@app.get("/api_app/status")
def rc_status():
    return {"status": "ready"}


@app.get("/api/info")
def db_info():
    """Return database connection info (safe fields only)."""
    return {
        "host": DB_CONFIG["host"],
        "database": DB_CONFIG["database"],
        "port": DB_CONFIG["port"],
        "env": (os.getenv("APP_ENV") or "LOCAL").upper(),
        "destructive_ops_enabled": DESTRUCTIVE_OPS_ENABLED,
    }


@app.get("/api/health")
def health_check():
    """Test DB connectivity — useful for debugging deployments."""
    try:
        with get_cursor() as cur:
            cur.execute("SELECT 1")
            cur.fetchone()
        return {"status": "healthy", "database": DB_CONFIG["database"], "host": DB_CONFIG["host"]}
    except Exception as e:
        return JSONResponse(
            status_code=503,
            content={"status": "unhealthy", "error": str(e)},
        )


@app.get("/api/tables")
def list_tables():
    with get_cursor() as cur:
        cur.execute("SHOW TABLES")
        table_names = [list(r.values())[0] for r in cur.fetchall()]

        # Find which tables have an is_current column
        cur.execute(
            "SELECT TABLE_NAME FROM information_schema.columns "
            "WHERE TABLE_SCHEMA = %s AND COLUMN_NAME = 'is_current'",
            (DB_CONFIG["database"],),
        )
        has_is_current = {list(r.values())[0] for r in cur.fetchall()}

        result = []
        for name in table_names:
            cur.execute(f"SELECT COUNT(*) AS cnt FROM `{name}`")
            cnt = cur.fetchone()["cnt"]
            entry = {"TABLE_NAME": name, "TABLE_ROWS": cnt}
            if name in has_is_current:
                cur.execute(f"SELECT COUNT(*) AS cnt FROM `{name}` WHERE is_current = 1")
                entry["CURRENT_ROWS"] = cur.fetchone()["cnt"]
            result.append(entry)

        result.sort(key=lambda t: t["TABLE_NAME"].lower())
    return {"tables": result}


@app.get("/api/tables/{name}/schema")
def table_schema(name: str):
    _validate_table_name(name)
    with get_cursor() as cur:
        cur.execute(
            "SELECT column_name, column_type, is_nullable, column_key, column_default, extra "
            "FROM information_schema.columns "
            "WHERE table_schema = %s AND table_name = %s "
            "ORDER BY ordinal_position",
            (DB_CONFIG["database"], name),
        )
        columns = cur.fetchall()
        cur.execute(f"SELECT COUNT(*) AS cnt FROM `{name}`")
        row_count = cur.fetchone()["cnt"]
    return {"table": name, "columns": columns, "row_count": row_count}


@app.get("/api/schema/all")
def all_schemas():
    """Return {table_name: [col1, col2, ...]} for SQL autocomplete."""
    with get_cursor() as cur:
        cur.execute(
            "SELECT TABLE_NAME, COLUMN_NAME "
            "FROM information_schema.columns "
            "WHERE TABLE_SCHEMA = %s "
            "ORDER BY TABLE_NAME, ORDINAL_POSITION",
            (DB_CONFIG["database"],),
        )
        result: dict[str, list[str]] = {}
        for r in cur.fetchall():
            tbl = list(r.values())[0]
            col = list(r.values())[1]
            result.setdefault(tbl, []).append(col)
    return {"schemas": result}


@app.get("/api/metadata/all")
def all_metadata():
    """Return columns + indexes for every table (sidebar tree view)."""
    with get_cursor() as cur:
        cur.execute(
            "SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, COLUMN_KEY, IS_NULLABLE "
            "FROM information_schema.columns "
            "WHERE TABLE_SCHEMA = %s "
            "ORDER BY TABLE_NAME, ORDINAL_POSITION",
            (DB_CONFIG["database"],),
        )
        columns_raw = cur.fetchall()

        cur.execute(
            "SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, COLUMN_NAME, SEQ_IN_INDEX "
            "FROM information_schema.statistics "
            "WHERE TABLE_SCHEMA = %s "
            "ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX",
            (DB_CONFIG["database"],),
        )
        indexes_raw = cur.fetchall()

    metadata: dict = {}
    for r in columns_raw:
        tbl = r["TABLE_NAME"]
        if tbl not in metadata:
            metadata[tbl] = {"columns": [], "indexes": []}
        metadata[tbl]["columns"].append({
            "name": r["COLUMN_NAME"],
            "type": r["COLUMN_TYPE"],
            "key": r["COLUMN_KEY"],
            "nullable": r["IS_NULLABLE"],
        })

    # Group index columns
    idx_map: dict[str, dict[str, dict]] = {}
    for r in indexes_raw:
        tbl = r["TABLE_NAME"]
        idx_name = r["INDEX_NAME"]
        if tbl not in idx_map:
            idx_map[tbl] = {}
        if idx_name not in idx_map[tbl]:
            idx_map[tbl][idx_name] = {
                "name": idx_name,
                "unique": r["NON_UNIQUE"] == 0,
                "columns": [],
            }
        idx_map[tbl][idx_name]["columns"].append(r["COLUMN_NAME"])

    for tbl, idxs in idx_map.items():
        if tbl in metadata:
            metadata[tbl]["indexes"] = list(idxs.values())

    return {"metadata": metadata}


@app.get("/api/tables/{name}/data")
def table_data(
    name: str,
    limit: int = 100,
    offset: int = 0,
    sort: str = "",
    order: str = "asc",
):
    _validate_table_name(name)
    limit = min(max(limit, 1), 1000)
    offset = max(offset, 0)

    order_clause = ""
    if sort:
        _validate_identifier(sort)
        direction = "DESC" if order.lower() == "desc" else "ASC"
        order_clause = f" ORDER BY `{sort}` {direction}"

    with get_cursor() as cur:
        cur.execute(f"SELECT COUNT(*) AS cnt FROM `{name}`")
        total = cur.fetchone()["cnt"]

        cur.execute(f"SELECT * FROM `{name}`{order_clause} LIMIT %s OFFSET %s", (limit, offset))
        rows = cur.fetchall()
        col_names = [d[0] for d in cur.description] if cur.description else []

    cleaned = []
    for row in rows:
        cleaned.append({k: _serialize(v) for k, v in row.items()})

    return {
        "table": name,
        "columns": col_names,
        "rows": cleaned,
        "total": total,
        "limit": limit,
        "offset": offset,
    }


DEFAULT_QUERY_LIMIT = 1000


def _apply_default_limit(sql: str) -> tuple[str, bool]:
    stripped = sql.strip().rstrip(";").strip()
    if not stripped.lower().startswith("select"):
        return sql, False
    if re.search(r"\blimit\b", stripped, re.IGNORECASE):
        return sql, False
    return f"{stripped} LIMIT {DEFAULT_QUERY_LIMIT}", True


@app.post("/api/query")
def run_query(body: dict):
    sql = body.get("sql", "").strip()
    if not sql:
        raise HTTPException(status_code=400, detail="Empty query")
    kind = validate_query_allowed(sql)

    if kind == "readonly":
        effective_sql, limit_applied = _apply_default_limit(sql)
    else:
        effective_sql, limit_applied = sql, False

    t0 = time.time()
    try:
        with get_connection() as conn:
            cur = conn.cursor(dictionary=True)
            try:
                cur.execute(effective_sql)
                rows = cur.fetchall() if cur.with_rows else []
                col_names = [d[0] for d in cur.description] if cur.description else []
                affected = cur.rowcount
                if kind == "destructive":
                    conn.commit()
            finally:
                cur.close()
    except MySQLError as e:
        # Surface MySQL errors (unknown column, syntax, etc.) as JSON 400 so the
        # UI can display them instead of FastAPI's default plain-text 500.
        raise HTTPException(status_code=400, detail=str(e))
    elapsed = round(time.time() - t0, 3)

    cleaned = []
    for row in rows:
        cleaned.append({k: _serialize(v) for k, v in row.items()})

    return {
        "columns": col_names,
        "rows": cleaned,
        "row_count": len(cleaned),
        "elapsed_seconds": elapsed,
        "limit_applied": limit_applied,
        "default_limit": DEFAULT_QUERY_LIMIT if limit_applied else None,
        "kind": kind,
        "affected_rows": affected if kind == "destructive" else None,
    }


def _require_destructive_enabled():
    if not DESTRUCTIVE_OPS_ENABLED:
        raise HTTPException(
            status_code=403,
            detail="Destructive ops disabled. Set DESTRUCTIVE_OPS_ENABLED=true on the backend.",
        )


@app.delete("/api/tables/{name}")
def drop_table(name: str):
    """DROP TABLE — feature-flagged. Front-end must show confirmation modal."""
    _require_destructive_enabled()
    _validate_table_name(name)
    t0 = time.time()
    try:
        with get_connection() as conn:
            cur = conn.cursor()
            try:
                cur.execute(f"DROP TABLE `{name}`")
                conn.commit()
            finally:
                cur.close()
    except MySQLError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {
        "table": name,
        "action": "drop_table",
        "elapsed_seconds": round(time.time() - t0, 3),
    }


@app.delete("/api/tables/{name}/rows")
def delete_rows(name: str, body: Optional[dict] = None):
    """DELETE FROM <table> [WHERE ...] — feature-flagged. Body may include {where: str}.

    If `where` is omitted the call deletes every row (TRUNCATE semantics).
    The UI must collect explicit user confirmation before invoking either form.
    """
    _require_destructive_enabled()
    _validate_table_name(name)
    where = (body or {}).get("where", "").strip()

    sql = f"DELETE FROM `{name}`"
    if where:
        # Disallow nested statements; the WHERE clause is executed verbatim, so
        # ban semicolons rather than try to parse user-supplied SQL.
        if ";" in where:
            raise HTTPException(status_code=400, detail="WHERE clause may not contain ';'")
        sql += f" WHERE {where}"

    t0 = time.time()
    try:
        with get_connection() as conn:
            cur = conn.cursor()
            try:
                cur.execute(sql)
                affected = cur.rowcount
                conn.commit()
            finally:
                cur.close()
    except MySQLError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {
        "table": name,
        "action": "delete_rows",
        "where": where or None,
        "affected_rows": affected,
        "elapsed_seconds": round(time.time() - t0, 3),
    }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _validate_table_name(name: str):
    if not re.match(r"^[a-zA-Z_][a-zA-Z0-9_]*$", name):
        raise HTTPException(status_code=400, detail="Invalid table name")


def _validate_identifier(name: str):
    if not re.match(r"^[a-zA-Z_][a-zA-Z0-9_]*$", name):
        raise HTTPException(status_code=400, detail="Invalid column name")


def _serialize(val):
    if val is None:
        return None
    if isinstance(val, (int, float, str, bool)):
        return val
    if isinstance(val, bytes):
        return val.decode("utf-8", errors="replace")
    return str(val)
