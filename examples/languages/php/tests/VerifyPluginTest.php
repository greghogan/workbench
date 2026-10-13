<?php

declare(strict_types=1);

use Composer\Package\Package;
use Composer\Plugin\PluginEvents;
use Composer\Plugin\PostFileDownloadEvent;
use PHPUnit\Framework\TestCase;
use WorkbenchVerification\VerifyPlugin;

final class VerifyPluginTest extends TestCase
{
    private string $directory;
    private VerifyPlugin $plugin;
    private PostFileDownloadEvent $event;
    private const KEY = 'example/package@1.0.0#revision';

    protected function setUp(): void
    {
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
}
