.PHONY: clean distclean

clean:
	rm -rf -- build dist htmlcov .coverage .pytest_cache .mypy_cache .ruff_cache
	find src tests -type d \( -name __pycache__ -o -name '*.egg-info' \) -prune -exec rm -rf -- {} +

distclean: clean
	rm -rf -- .venv
