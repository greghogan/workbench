"""Small typed behavior exercised by the reference checks."""


def add(left: int, right: int) -> int:
    """Add two integers.

    >>> add(20, 22)
    42
    """
    return left + right


_MAX_BYTE = 255


def count_byte(data: bytes, needle: int) -> int:
    """Count a byte, rejecting values outside the byte domain.

    >>> count_byte(b"banana", ord("a"))
    3
    """
    if not 0 <= needle <= _MAX_BYTE:
        msg = "needle must be a byte (0 through 255)"
        raise ValueError(msg)
    return data.count(needle)
