<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CliTest extends TestCase
{
    /**
     * @param list<string> $args
     * @return array{int, string, string}
     */
    private function invoke(array $args): array
    {
        $process = proc_open([PHP_BINARY, __DIR__ . "/../bin/count", ...$args], [1 => ["pipe", "w"], 2 => ["pipe", "w"]], $pipes);
        self::assertIsResource($process);
        $stdout = stream_get_contents($pipes[1]);
        $stderr = stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);
        return [proc_close($process), $stdout, $stderr];
    }

    public function testSuccess(): void
    {
        self::assertSame([0, "2" . PHP_EOL, ""], $this->invoke(["110", "banana"]));
    }

    public function testInvalidArguments(): void
    {
        foreach ([["256", "banana"], ["bad", "banana"], []] as $args) {
            [$status, $stdout, $stderr] = $this->invoke($args);
            self::assertSame(2, $status);
            self::assertSame("", $stdout);
            self::assertNotSame("", $stderr);
        }
    }
}
