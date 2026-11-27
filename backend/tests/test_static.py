"""SPAStaticFiles: client routes fall through to index.html, an unanswered API path is a 404 (never the HTML shell),
and no request can be served a file outside the static directory (path-traversal regression)."""

import pytest
from fastapi import FastAPI
from starlette.applications import Starlette
from starlette.testclient import TestClient

from app.main import SPAStaticFiles

INDEX_HTML = '<!doctype html><html><body><div id="root"></div>SPA-SHELL</body></html>'
SECRET = "TOP-SECRET-DO-NOT-SERVE\n"


@pytest.fixture()
def spa(tmp_path):
    static = tmp_path / "static"
    (static / "assets").mkdir(parents=True)
    (static / "index.html").write_text(INDEX_HTML)
    (static / "favicon.svg").write_text("<svg/>")
    (static / "assets" / "app.js").write_text("console.log(1)")
    # sensitive files that live OUTSIDE the served directory
    (tmp_path / "secret.txt").write_text(SECRET)

    app = Starlette()
    app.mount("/", SPAStaticFiles(directory=static, html=True), name="spa")
    return TestClient(app), static


def test_root_serves_index(spa):
    client, _ = spa
    r = client.get("/")
    assert r.status_code == 200 and "SPA-SHELL" in r.text


def test_client_routes_fall_back_to_index(spa):
    client, _ = spa
    for path in ("/dashboard", "/account", "/requests", "/workspace", "/welcome", "/a/deep/route"):
        r = client.get(path)
        assert r.status_code == 200, path
        assert "SPA-SHELL" in r.text, path


@pytest.mark.parametrize("path", ["/api/me", "/api/definitely/not/here", "/api", "/v1/models", "/v1", "/v1beta/nothing", "/api/"])
def test_an_unanswered_api_path_is_a_404_not_the_app_shell(spa, path):
    client, _ = spa
    r = client.get(path)
    assert r.status_code == 404, path
    assert "SPA-SHELL" not in r.text, path


@pytest.mark.parametrize("path", ["/apis", "/api-docs", "/v10", "/v1beta2/x", "/apiary/dashboard"])
def test_only_the_exact_api_prefixes_are_reserved(spa, path):
    client, _ = spa
    r = client.get(path)
    assert r.status_code == 200 and "SPA-SHELL" in r.text, path


def test_the_404_is_json_like_every_other_api_error(tmp_path):
    static = tmp_path / "static"
    static.mkdir()
    (static / "index.html").write_text(INDEX_HTML)
    app = FastAPI()
    app.mount("/", SPAStaticFiles(directory=static, html=True), name="spa")
    r = TestClient(app).get("/api/me")
    assert r.status_code == 404
    assert r.headers["content-type"].startswith("application/json")
    assert r.json() == {"detail": "Not Found"}


def test_real_assets_are_served(spa):
    client, _ = spa
    assert client.get("/favicon.svg").text == "<svg/>"
    assert client.get("/assets/app.js").text == "console.log(1)"


@pytest.mark.parametrize(
    "vector",
    [
        "/../secret.txt",
        "/../../secret.txt",
        "/../../../../secret.txt",
        "/../../../../etc/passwd",
        "/..%2f..%2fsecret.txt",
        "/..%2F..%2Fsecret.txt",
        "/%2e%2e/%2e%2e/secret.txt",
        "/%2e%2e%2f%2e%2e%2fsecret.txt",
        "/....//....//secret.txt",
        "/assets/../../secret.txt",
        "/assets/..%2f..%2fsecret.txt",
        "/..%5c..%5csecret.txt",
    ],
)
def test_traversal_cannot_escape_static_dir(spa, vector):
    client, _ = spa
    r = client.get(vector)
    # Never the out-of-tree file. Either the SPA shell (200) or a 4xx — never a leak.
    assert "TOP-SECRET" not in r.text
    assert "root:x:0:0" not in r.text
    if r.status_code == 200:
        assert "SPA-SHELL" in r.text


def test_lookup_path_reports_traversal_as_missing(spa):
    _, static = spa
    sf = SPAStaticFiles(directory=static, html=True)
    for p in ("../secret.txt", "../../secret.txt", "../../../../etc/passwd"):
        _full, stat_result = sf.lookup_path(p)
        assert stat_result is None, p
