<?php

declare(strict_types=1);

$finder = new PhpCsFixer\Finder();
$finder->in([__DIR__ . "/src", __DIR__ . "/tests", __DIR__ . "/.composer/verify/src"]);
$finder->append([__DIR__ . "/bin/count", __FILE__, __DIR__ . "/.phpstan-bootstrap.php"]);

return (new PhpCsFixer\Config())
    ->setParallelConfig(new PhpCsFixer\Runner\Parallel\ParallelConfig(max(1, (int) (getenv("WORKBENCH_JOB_CPUS") ?: 1))))
    ->setRiskyAllowed(true)
    ->setRules(["@PER-CS3x0" => true, "@PHP82Migration" => true, "declare_strict_types" => true, "strict_comparison" => true])
    ->setFinder($finder);
