"""tiny-todo: an in-memory todo list served by Flask."""
from flask import Flask, jsonify, request

app = Flask(__name__)

TODOS: dict[int, dict] = {}
_next_id = 1


def reset():
    """Clear the store. Used by tests."""
    global _next_id
    TODOS.clear()
    _next_id = 1


def _create(title: str, done: bool = False) -> dict:
    global _next_id
    todo = {"id": _next_id, "title": title, "done": done}
    TODOS[_next_id] = todo
    _next_id += 1
    return todo


@app.get("/todos")
def list_todos():
    return jsonify(sorted(TODOS.values(), key=lambda t: t["id"]))


@app.post("/todos")
def create_todo():
    body = request.get_json(silent=True) or {}
    title = body.get("title")
    if not isinstance(title, str) or not title.strip():
        return jsonify({"error": "title is required"}), 400
    todo = _create(title.strip(), bool(body.get("done", False)))
    return jsonify(todo), 201


@app.get("/todos/<int:todo_id>")
def get_todo(todo_id: int):
    todo = TODOS.get(todo_id)
    if todo is None:
        return jsonify({"error": "not found"}), 404
    return jsonify(todo)


if __name__ == "__main__":
    app.run(debug=True)
