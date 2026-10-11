<?php

declare(strict_types=1);

namespace WorkbenchVerification;

use Composer\Composer;
use Composer\EventDispatcher\EventSubscriberInterface;
use Composer\IO\IOInterface;
use Composer\Package\PackageInterface;
use Composer\Plugin\PluginEvents;
use Composer\Plugin\PluginInterface;
use Composer\Plugin\PostFileDownloadEvent;
use RuntimeException;

/** Composer downloads and extracts; this hook adds a fail-closed archive verification step. */
final class VerifyPlugin implements PluginInterface, EventSubscriberInterface
{
    private string $file;

    public function activate(Composer $composer, IOInterface $io): void
    {
        $composer->getDownloadManager()->setSourceFallback(false);
        $composer->getDownloadManager()->setPreferSource(false);
        $composer->getDownloadManager()->setPreferDist(true);
        $this->file = dirname(realpath(getenv('COMPOSER') ?: 'composer.json') ?: throw new RuntimeException('Missing manifest')) . '/.composer/checksums.json';
    }

    public function deactivate(Composer $composer, IOInterface $io): void {}

    public function uninstall(Composer $composer, IOInterface $io): void {}

    /** @return array<string, string> */
    public static function getSubscribedEvents(): array
    {
        return [PluginEvents::POST_FILE_DOWNLOAD => 'verify'];
    }

    public function verify(PostFileDownloadEvent $event): void
    {
        if ($event->getType() !== 'package') {
            return;
        }
        $package = $event->getContext();
        if (!$package instanceof PackageInterface) {
            throw new RuntimeException('Unsupported Composer download context');
        }
        $key = $package->getName() . '@' . $package->getPrettyVersion() . '#' . $package->getDistReference();
        $archive = $event->getFileName() ?? throw new RuntimeException('Missing downloaded archive');
        $digest = hash_file('sha256', $archive);
        $checksums = json_decode(file_get_contents($this->file) ?: throw new RuntimeException('Missing trusted Composer checksum catalog'), true, flags: JSON_THROW_ON_ERROR);
        if (!is_array($checksums) || !is_string($digest)) {
            throw new RuntimeException('Invalid trusted Composer checksum catalog');
        }
        if (getenv('WORKBENCH_COMPOSER_RECORD_CHECKSUMS') === 'true') {
            // Events are serialized by Composer's main loop even when HTTP requests run concurrently.
            $checksums[$key] = $digest;
            ksort($checksums);
            $temporary = $this->file . '.partial';
            file_put_contents($temporary, json_encode((object) $checksums, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR) . "\n");
            rename($temporary, $this->file);
        } elseif (!isset($checksums[$key]) || !is_string($checksums[$key]) || !preg_match('/^[a-f0-9]{64}$/D', $checksums[$key]) || !hash_equals($checksums[$key], $digest)) {
            throw new RuntimeException('Missing or mismatched trusted Composer SHA-256: ' . $key);
        }
    }
}
