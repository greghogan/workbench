"""Public byte-counting behavior, including invalid inputs."""

import unittest

from workbench_python_reference.arithmetic import count_byte


class CountTests(unittest.TestCase):
    """Validate exact counts and the accepted byte domain."""

    def test_counts_boundaries(self) -> None:
        for data, needle, expected in [(b"", 0, 0), (b"banana", 97, 3), (bytes([255]) * 65, 255, 65)]:
            with self.subTest(data=data, needle=needle):
                self.assertEqual(count_byte(data, needle), expected)

    def test_rejects_non_bytes(self) -> None:
        for needle in [-1, 256]:
            with self.subTest(needle=needle), self.assertRaisesRegex(ValueError, "needle must be a byte"):
                count_byte(b"", needle)
