<?php

declare(strict_types=1);

require __DIR__ . "/../src/Arithmetic.php";

require 'phar://' . (getenv('WORKBENCH_COMPOSER_PHAR') ?: throw new RuntimeException('Missing verified Composer API')) . '/vendor/autoload.php';
require __DIR__ . '/../.composer/verify/src/VerifyPlugin.php';
