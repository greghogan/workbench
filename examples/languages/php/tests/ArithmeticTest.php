<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;
use WorkbenchReference\Arithmetic;

final class ArithmeticTest extends TestCase
{
    public function testSum(): void
    {
        self::assertSame(6, Arithmetic::sum([1, 2, 3]));
        self::assertSame(0, Arithmetic::sum([]));
        self::assertSame(-1, Arithmetic::sum([-2, 1]));
    }

    public function testCountByte(): void
    {
        self::assertSame(2, Arithmetic::countByte("banana", 110));
        self::assertSame(0, Arithmetic::countByte("", 0));
        self::assertSame(1, Arithmetic::countByte("\0\xff", 0));
        self::assertSame(1, Arithmetic::countByte("\0\xff", 255));
    }

    public function testRejectsLowByte(): void
    {
        $this->expectException(OutOfRangeException::class);
        Arithmetic::countByte("", -1);
    }

    public function testRejectsHighByte(): void
    {
        $this->expectException(OutOfRangeException::class);
        Arithmetic::countByte("", 256);
    }
}
