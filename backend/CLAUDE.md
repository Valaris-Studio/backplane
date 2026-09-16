# Backend — Quick Reference

```bash
# Activate venv (required before all commands)
source .venv/bin/activate

# Tests
python -m pytest -v                          # all tests
python -m pytest tests/test_boards.py -v     # single file
python -m pytest -k "test_create_board" -v   # single test

# Lint and format
ruff check app/
ruff format app/

# Migrations (run from backend/)
alembic revision --autogenerate -m "description"
alembic upgrade head
alembic downgrade -1

# Run dev server standalone
uvicorn app.main:app --reload --port 8000
```

Swagger UI: `localhost:8000/api/docs`

Layers: Router -> Service -> Repository -> Model. Never skip.

### Fast inner-loop tests

During active development, run the parallel fast suite instead of the full serial:
```
make test-fast  # pytest -n auto -m "not slow"
```

The full serial `make test` remains the authoritative run (pre-commit / CI).
Mark new integration tests that take >500ms individually with `@pytest.mark.slow`.
