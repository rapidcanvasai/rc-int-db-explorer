"""Tests for the DESTRUCTIVE_OPS_ENABLED feature flag and DELETE/DROP routes."""


def test_info_reports_flag_off(client):
    res = client.get("/api/info")
    assert res.status_code == 200
    body = res.json()
    assert body["destructive_ops_enabled"] is False


def test_info_reports_flag_on(destructive_client):
    res = destructive_client.get("/api/info")
    assert res.status_code == 200
    assert res.json()["destructive_ops_enabled"] is True


# ---------------------------------------------------------------------------
# /api/query gating
# ---------------------------------------------------------------------------

def test_query_select_allowed_when_flag_off(client, fake_db):
    fake_db["fetchall"] = [{"x": 1}]
    fake_db["description"] = [("x",)]
    res = client.post("/api/query", json={"sql": "SELECT 1 AS x"})
    assert res.status_code == 200
    body = res.json()
    assert body["kind"] == "readonly"
    assert body["affected_rows"] is None


def test_query_delete_blocked_when_flag_off(client, fake_db):
    res = client.post("/api/query", json={"sql": "DELETE FROM widgets"})
    assert res.status_code == 403
    assert "DESTRUCTIVE_OPS_ENABLED" in res.json()["detail"]
    # No SQL should have hit the DB.
    assert fake_db["executed"] == []


def test_query_drop_blocked_when_flag_off(client, fake_db):
    res = client.post("/api/query", json={"sql": "DROP TABLE widgets"})
    assert res.status_code == 403
    assert fake_db["executed"] == []


def test_query_insert_still_blocked_when_flag_on(destructive_client, fake_db):
    """The flag only opens DELETE/DROP/TRUNCATE, not arbitrary writes."""
    res = destructive_client.post("/api/query", json={"sql": "INSERT INTO t VALUES (1)"})
    assert res.status_code == 403
    assert fake_db["executed"] == []


def test_query_delete_runs_when_flag_on(destructive_client, fake_db):
    fake_db["rowcount"] = 7
    res = destructive_client.post("/api/query", json={"sql": "DELETE FROM widgets WHERE id=1"})
    assert res.status_code == 200
    body = res.json()
    assert body["kind"] == "destructive"
    assert body["affected_rows"] == 7
    assert any("DELETE FROM widgets" in sql for sql, _ in fake_db["executed"])
    assert fake_db["committed"] == 1


def test_query_drop_runs_when_flag_on(destructive_client, fake_db):
    res = destructive_client.post("/api/query", json={"sql": "DROP TABLE widgets"})
    assert res.status_code == 200
    assert res.json()["kind"] == "destructive"
    assert fake_db["committed"] == 1


# ---------------------------------------------------------------------------
# Dedicated endpoints
# ---------------------------------------------------------------------------

def test_drop_table_endpoint_blocked_when_flag_off(client, fake_db):
    res = client.delete("/api/tables/widgets")
    assert res.status_code == 403
    assert fake_db["executed"] == []


def test_drop_table_endpoint_runs_when_flag_on(destructive_client, fake_db):
    res = destructive_client.delete("/api/tables/widgets")
    assert res.status_code == 200
    body = res.json()
    assert body["table"] == "widgets"
    assert body["action"] == "drop_table"
    assert fake_db["committed"] == 1
    assert any("DROP TABLE `widgets`" in sql for sql, _ in fake_db["executed"])


def test_drop_table_rejects_invalid_name(destructive_client, fake_db):
    res = destructive_client.delete("/api/tables/widgets;drop")
    # FastAPI may reject the path before our handler sees it.
    assert res.status_code in (400, 404)
    assert fake_db["executed"] == []


def test_delete_rows_blocked_when_flag_off(client, fake_db):
    res = client.request("DELETE", "/api/tables/widgets/rows", json={"where": "id=1"})
    assert res.status_code == 403
    assert fake_db["executed"] == []


def test_delete_rows_with_where_runs_when_flag_on(destructive_client, fake_db):
    fake_db["rowcount"] = 3
    res = destructive_client.request(
        "DELETE", "/api/tables/widgets/rows", json={"where": "id=1"}
    )
    assert res.status_code == 200
    body = res.json()
    assert body["affected_rows"] == 3
    assert body["where"] == "id=1"
    assert any("DELETE FROM `widgets` WHERE id=1" in sql for sql, _ in fake_db["executed"])
    assert fake_db["committed"] == 1


def test_delete_rows_without_where_runs_when_flag_on(destructive_client, fake_db):
    fake_db["rowcount"] = 12
    res = destructive_client.request("DELETE", "/api/tables/widgets/rows", json={})
    assert res.status_code == 200
    body = res.json()
    assert body["where"] is None
    assert body["affected_rows"] == 12


def test_delete_rows_rejects_semicolon_in_where(destructive_client, fake_db):
    res = destructive_client.request(
        "DELETE",
        "/api/tables/widgets/rows",
        json={"where": "id=1; DROP TABLE widgets"},
    )
    assert res.status_code == 400
    assert fake_db["executed"] == []


def test_delete_rows_rejects_invalid_table_name(destructive_client, fake_db):
    res = destructive_client.request("DELETE", "/api/tables/bad-name/rows", json={})
    assert res.status_code == 400
    assert fake_db["executed"] == []


# ---------------------------------------------------------------------------
# classify_query unit checks
# ---------------------------------------------------------------------------

def test_classify_query_handles_whitespace_and_case():
    from app import main

    assert main.classify_query("  select * from t") == "readonly"
    assert main.classify_query("Delete from t") == "destructive"
    assert main.classify_query("DROP TABLE t;") == "destructive"
    assert main.classify_query("truncate t") == "destructive"
    assert main.classify_query("update t set x=1") == "other"
    assert main.classify_query("") == "other"


def test_env_flag_parsing():
    from app import main

    assert main._env_flag("UNSET_VAR", default=False) is False
    assert main._env_flag("UNSET_VAR", default=True) is True
