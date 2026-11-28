<?php

declare(strict_types=1);

require $argv[3];
$coverage = require $argv[1];
$root = realpath($argv[2]);
if (!is_array($coverage) || ($coverage['buildInformation']['phpCodeCoverage']['serializationFormat'] ?? null) !== 4) {
    throw new RuntimeException('Unsupported PHP coverage serialization format');
}
$data = $coverage['codeCoverage'];
$base = $coverage['basePath'];
$files = [];
$measured = ['lines' => 0, 'branches' => 0, 'functions' => 0];
$metric = static function (array $hits): array {
    $covered = count(array_filter($hits, static fn (int $hit): bool => $hit > 0));
    $total = count($hits);
    return ['total' => $total, 'covered' => $covered];
};
foreach ($data->lineCoverage() as $relative => $lines) {
    $absolute = realpath($base . '/' . $relative);
    if ($absolute === false) throw new RuntimeException('Missing covered source file');
    if (!str_starts_with($absolute, $root . '/src/')) {
        throw new RuntimeException('PHP coverage source outside production directory');
    }
    $hits = ['lines' => [], 'branches' => [], 'functions' => []];
    foreach ($lines as $tests) {
        $hits['lines'][] = count($tests);
    }
    foreach ($data->functionCoverage()[$relative] ?? [] as $function) {
        $functionHits = 0;
        foreach ($function->branches as $branch) {
            $branchHits = array_sum($branch->hit);
            $functionHits += $branchHits;
            $hits['branches'][] = $branchHits;
        }
        $hits['functions'][] = $functionHits;
    }
    $file = [];
    foreach ($hits as $name => $values) {
        $file[$name] = $metric($values);
        $measured[$name] += count($values);
    }
    $files[substr($absolute, strlen($root) + 1)] = $file;
}
if (in_array(0, $measured, true)) {
    throw new RuntimeException('PHP coverage lacks production line, branch or function counters');
}
ksort($files);
$directory = $root . '/coverage';
if (!is_dir($directory)) {
    mkdir($directory, 0700, true);
}
$summary = json_encode($files, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR) . "\n";
$temporary = tempnam($directory, '.summary-');
if ($temporary === false) {
    throw new RuntimeException('Unable to stage PHP coverage summary');
}
try {
    if (dirname($temporary) !== realpath($directory)
        || file_put_contents($temporary, $summary) !== strlen($summary)
        || !rename($temporary, $directory . '/coverage-summary.json')) {
        throw new RuntimeException('Unable to publish PHP coverage summary');
    }
} finally {
    if (is_file($temporary)) {
        unlink($temporary);
    }
}
