import pytest

import app as todo_app


@pytest.fixture
def client():
    todo_app.reset()
    todo_app.app.config["TESTING"] = True
    with todo_app.app.test_client() as c:
        yield c


def test_list_empty(client):
    res = client.get("/todos")
    assert res.status_code == 200
    assert res.get_json() == []


def test_create_and_get(client):
    res = client.post("/todos", json={"title": "write tests"})
    assert res.status_code == 201
    todo = res.get_json()
    assert todo["id"] == 1
    assert todo["title"] == "write tests"
    assert todo["done"] is False

    res = client.get("/todos/1")
    assert res.status_code == 200
    assert res.get_json() == todo


def test_create_requires_title(client):
    res = client.post("/todos", json={})
    assert res.status_code == 400


def test_get_missing(client):
    res = client.get("/todos/99")
    assert res.status_code == 404


def test_list_is_ordered(client):
    client.post("/todos", json={"title": "a"})
    client.post("/todos", json={"title": "b"})
    titles = [t["title"] for t in client.get("/todos").get_json()]
    assert titles == ["a", "b"]
