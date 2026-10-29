"""Behavior tests for the Python reference package."""

import unittest

from workbench_python_reference import add


class ArithmeticTests(unittest.TestCase):
    """Exercise the public API."""

    def test_adds_values(self) -> None:
        self.assertEqual(add(20, 22), 42)


if __name__ == "__main__":
    unittest.main()
