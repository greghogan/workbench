<?php

declare(strict_types=1);

use Composer\Package\Package;
use Composer\Plugin\PluginEvents;
use Composer\Plugin\PostFileDownloadEvent;
use Composer\Plugin\PreFileDownloadEvent;
use Composer\Util\HttpDownloader;
use Composer\IO\NullIO;
use Composer\Config;
use PHPUnit\Framework\TestCase;
use WorkbenchVerification\VerifyPlugin;

final class VerifyPluginTest extends TestCase
{
    private string $directory;
    private string|false $managedInputs;
    private VerifyPlugin $plugin;
    private PostFileDownloadEvent $event;
    private const KEY = 'example/package@1.0.0#revision';

    protected function setUp(): void
    {
        $this->managedInputs = getenv('WORKBENCH_CHECK_INPUTS');
        $this->directory = sys_get_temp_dir() . '/workbench-verifier-' . bin2hex(random_bytes(12));
        mkdir($this->directory, 0o700);
        file_put_contents($this->directory . '/archive.zip', 'verified archive bytes');
        $this->catalog([self::KEY => hash('sha256', 'verified archive bytes')]);
        $this->plugin = new VerifyPlugin();
        (new ReflectionProperty(VerifyPlugin::class, 'file'))->setValue($this->plugin, $this->directory . '/checksums.json');
        $package = new Package('example/package', '1.0.0.0', '1.0.0');
        $package->setDistReference('revision');
        $this->event = new PostFileDownloadEvent(PluginEvents::POST_FILE_DOWNLOAD, $this->directory . '/archive.zip', null, 'https://example.test/archive.zip', 'package', $package);
    }

    protected function tearDown(): void
    {
        putenv('WORKBENCH_COMPOSER_RECORD_CHECKSUMS');
        putenv($this->managedInputs === false ? 'WORKBENCH_CHECK_INPUTS' : 'WORKBENCH_CHECK_INPUTS=' . $this->managedInputs);
        foreach (glob($this->directory . '/*') ?: [] as $file) {
            unlink($file);
        }
        rmdir($this->directory);
    }

    /** @param array<string, string> $values */
    private function catalog(array $values): void
    {
        file_put_contents($this->directory . '/checksums.json', json_encode((object) $values, JSON_THROW_ON_ERROR));
    }

    public function testVerifiedArchiveAndCacheHit(): void
    {
        $before = file_get_contents($this->directory . '/checksums.json');
        $this->plugin->verify($this->event);
        $this->plugin->verify($this->event);
        self::assertSame($before, file_get_contents($this->directory . '/checksums.json'));
    }

    public function testTamperedArchiveFails(): void
    {
        file_put_contents($this->directory . '/archive.zip', 'tampered');
        $this->expectException(RuntimeException::class);
        $this->expectExceptionMessage('Missing or mismatched');
        $this->plugin->verify($this->event);
    }

    public function testMissingTrustedDigestFails(): void
    {
        $this->catalog([]);
        $this->expectException(RuntimeException::class);
        $this->plugin->verify($this->event);
    }

    public function testInvalidTrustedDigestFails(): void
    {
        $this->catalog([self::KEY => 'not a SHA-256']);
        $this->expectException(RuntimeException::class);
        $this->plugin->verify($this->event);
    }

    public function testExplicitRefreshRecordsArchiveDigest(): void
    {
        $this->catalog([]);
        putenv('WORKBENCH_COMPOSER_RECORD_CHECKSUMS=true');
        $this->plugin->verify($this->event);
        self::assertSame(json_encode((object) [self::KEY => hash('sha256', 'verified archive bytes')], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR) . "\n", file_get_contents($this->directory . '/checksums.json'));
        self::assertFileDoesNotExist($this->directory . '/checksums.json.partial');
    }
    private function sourceEvent(string $type = 'package', mixed $context = null): PreFileDownloadEvent
    {
        $package = new Package('example/package', '1.0.0.0', '1.0.0');
        $package->setDistUrl('https://example.test/archive.zip');
        return new PreFileDownloadEvent(PluginEvents::PRE_FILE_DOWNLOAD, new HttpDownloader(new NullIO(), new Config()), 'https://example.test/archive.zip', $type, $context ?? $package);
    }

    public function testManagedSourceUsesDeclaredLocalArchive(): void
    {
        putenv('WORKBENCH_CHECK_INPUTS=' . $this->directory);
        file_put_contents($this->directory . '/manifest.json', json_encode(['inputs' => [
            ['url' => 'https://example.test/unrelated.zip', 'destination' => 'composer/other.zip'],
            ['url' => 'https://example.test/archive.zip', 'destination' => 'composer/verified.zip'],
        ]], JSON_THROW_ON_ERROR));
        $event = $this->sourceEvent();
        $this->plugin->source($event);
        self::assertSame('file://' . $this->directory . '/composer/verified.zip', $event->getProcessedUrl());
    }

    public function testNativeSourceRemainsOwnedByComposer(): void
    {
        putenv('WORKBENCH_CHECK_INPUTS');
        $event = $this->sourceEvent();
        $this->plugin->source($event);
        self::assertSame('https://example.test/archive.zip', $event->getProcessedUrl());
    }

    public function testManagedMetadataRequestsAreUnchanged(): void
    {
        putenv('WORKBENCH_CHECK_INPUTS=' . $this->directory);
        $event = $this->sourceEvent('metadata');
        $this->plugin->source($event);
        self::assertSame('https://example.test/archive.zip', $event->getProcessedUrl());
    }

    public function testUndeclaredManagedSourceCannotFallBackToNetwork(): void
    {
        putenv('WORKBENCH_CHECK_INPUTS=' . $this->directory);
        file_put_contents($this->directory . '/manifest.json', '{"inputs":[]}');
        $this->expectException(RuntimeException::class);
        $this->expectExceptionMessage('No declared managed source');
        $this->plugin->source($this->sourceEvent());
    }

    public function testManagedSourceRejectsEscapingPaths(): void
    {
        putenv('WORKBENCH_CHECK_INPUTS=' . $this->directory);
        file_put_contents($this->directory . '/manifest.json', json_encode(['inputs' => [
            ['url' => 'https://example.test/archive.zip', 'destination' => 'composer/../escape.zip'],
        ]], JSON_THROW_ON_ERROR));
        $this->expectException(RuntimeException::class);
        $this->expectExceptionMessage('Invalid managed Composer source');
        $this->plugin->source($this->sourceEvent());
    }

    public function testManagedSourceRejectsUnknownDownloadContexts(): void
    {
        putenv('WORKBENCH_CHECK_INPUTS=' . $this->directory);
        $this->expectException(RuntimeException::class);
        $this->expectExceptionMessage('Unsupported Composer download context');
        $this->plugin->source($this->sourceEvent(context: new stdClass()));
    }

}
