<?php

declare(strict_types=1);

namespace WorkbenchReference;

use OutOfRangeException;

final class Arithmetic
{
    /** @param list<int> $values */
    public static function sum(array $values): int
    {
        return array_sum($values);
    }

    public static function countByte(string $data, int $byte): int
    {
        if ($byte < 0 || $byte > 255) {
            throw new OutOfRangeException("byte must be between 0 and 255");
        }

        return substr_count($data, chr($byte));
    }
}
