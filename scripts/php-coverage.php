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
$totals = ['lines' => [], 'branches' => [], 'functions' => []];
$metric = static function (array $hits): array {
    $covered = count(array_filter($hits, static fn (int $hit): bool => $hit > 0));
    $total = count($hits);
    return ['total' => $total, 'covered' => $covered, 'skipped' => 0, 'pct' => $total ? floor($covered / $total * 10000) / 100 : 100];
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
        array_push($totals[$name], ...$values);
    }
    $files[substr($absolute, strlen($root) + 1)] = $file;
}
if (!$totals['lines'] || !$totals['branches'] || !$totals['functions']) {
    throw new RuntimeException('PHP coverage lacks production line, branch or function counters');
}
ksort($files);
$summary = ['total' => array_map($metric, $totals)] + $files;
if (!is_dir($root . '/coverage')) {
    mkdir($root . '/coverage', 0700, true);
}
file_put_contents($root . '/coverage/coverage-summary.json', json_encode($summary, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR) . "\n");
