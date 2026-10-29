<?php

declare(strict_types=1);

use Composer\Package\Package;
use Composer\Plugin\PluginEvents;
use Composer\Plugin\PostFileDownloadEvent;
use Composer\Plugin\PreFileDownloadEvent;
use Composer\Util\HttpDownloader;
use Composer\IO\NullIO;
use Composer\Config;
use Composer\Composer;
use Composer\PartialComposer;
use Composer\Downloader\ArchiveDownloader;
use Composer\Downloader\DownloadManager;
use Composer\Downloader\DownloaderInterface;
use Composer\EventDispatcher\EventDispatcher;
use Composer\Package\PackageInterface;
use Composer\Package\RootPackage;
use Composer\Util\Filesystem;
use Composer\Util\Loop;
use PHPUnit\Framework\TestCase;
use React\Promise\PromiseInterface;
use WorkbenchVerification\VerifyPlugin;

final class VerifyPluginTest extends TestCase
{
    private string $directory;
    private string|false $managedInputs;
    private string|false $composerManifest;
    private string|false $recordChecksums;
    private Composer $composer;
    private DownloadManager $downloads;
    private VerifyPlugin $plugin;
    private PostFileDownloadEvent $event;
    private const KEY = 'example/package@1.0.0#revision';

    protected function setUp(): void
    {
        $this->managedInputs = getenv('WORKBENCH_CHECK_INPUTS');
        $this->composerManifest = getenv('COMPOSER');
        $this->recordChecksums = getenv('WORKBENCH_COMPOSER_RECORD_CHECKSUMS');
        putenv('WORKBENCH_CHECK_INPUTS');
        putenv('WORKBENCH_COMPOSER_RECORD_CHECKSUMS');
        $this->directory = sys_get_temp_dir() . '/workbench-verifier-' . bin2hex(random_bytes(12));
        mkdir($this->directory, 0o700);
        mkdir($this->directory . '/.composer', 0o700);
        file_put_contents($this->directory . '/composer.json', '{}');
        putenv('COMPOSER=' . $this->directory . '/composer.json');
        file_put_contents($this->directory . '/archive.zip', 'verified archive bytes');
        $this->catalog([self::KEY => hash('sha256', 'verified archive bytes')]);
        $this->plugin = new VerifyPlugin();
        $this->downloads = new DownloadManager(new NullIO(), true);
        $this->composer = new Composer();
        $this->composer->setDownloadManager($this->downloads);
        $this->plugin->activate($this->composer, new NullIO());
        $package = new Package('example/package', '1.0.0.0', '1.0.0');
        $package->setDistReference('revision');
        $this->event = new PostFileDownloadEvent(PluginEvents::POST_FILE_DOWNLOAD, $this->directory . '/archive.zip', null, 'https://example.test/archive.zip', 'package', $package);
    }

    protected function tearDown(): void
    {
        putenv($this->recordChecksums === false ? 'WORKBENCH_COMPOSER_RECORD_CHECKSUMS' : 'WORKBENCH_COMPOSER_RECORD_CHECKSUMS=' . $this->recordChecksums);
        putenv($this->composerManifest === false ? 'COMPOSER' : 'COMPOSER=' . $this->composerManifest);
        putenv($this->managedInputs === false ? 'WORKBENCH_CHECK_INPUTS' : 'WORKBENCH_CHECK_INPUTS=' . $this->managedInputs);
        (new Filesystem())->removeDirectory($this->directory);
    }

    /** @param array<string, string> $values */
    private function catalog(array $values): void
    {
        file_put_contents($this->directory . '/.composer/checksums.json', json_encode((object) $values, JSON_THROW_ON_ERROR));
    }

    public function testVerifiedArchiveAndCacheHit(): void
    {
        $before = file_get_contents($this->directory . '/.composer/checksums.json');
        $this->plugin->verify($this->event);
        $this->plugin->verify($this->event);
        self::assertSame($before, file_get_contents($this->directory . '/.composer/checksums.json'));
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
        self::assertSame(json_encode((object) [self::KEY => hash('sha256', 'verified archive bytes')], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR) . "\n", file_get_contents($this->directory . '/.composer/checksums.json'));
        self::assertFileDoesNotExist($this->directory . '/.composer/checksums.json.partial');
    }

    private function downloadPackage(string $url): Package
    {
        $package = new Package('example/package', '1.0.0.0', '1.0.0');
        $package->setDistType('zip');
        $package->setDistUrl($url);
        $package->setDistReference('revision');
        $package->setSourceType('git');
        $package->setSourceUrl('https://example.test/source.git');
        $package->setSourceReference('revision');
        return $package;
    }

    public function testFailedDistributionNeverFallsBackToSource(): void
    {
        $dist = $this->createMock(DownloaderInterface::class);
        $dist->method('getInstallationSource')->willReturn('dist');
        $dist->expects(self::once())->method('download')->willReturn(\React\Promise\reject(new RuntimeException('fixture distribution failed')));
        $source = $this->createMock(DownloaderInterface::class);
        $source->method('getInstallationSource')->willReturn('source');
        $source->expects(self::never())->method('download');
        $this->downloads->setDownloader('zip', $dist)->setDownloader('git', $source);
        $package = $this->downloadPackage('https://example.test/archive.zip');
        $failure = null;
        $this->downloads->download($package, $this->directory . '/install')->then(
            static function (): void {},
            static function (Throwable $error) use (&$failure): void {
                $failure = $error;
            },
        );
        self::assertInstanceOf(RuntimeException::class, $failure);
        self::assertSame('fixture distribution failed', $failure->getMessage());
        self::assertSame('dist', $package->getInstallationSource());
        self::assertDirectoryDoesNotExist($this->directory . '/install');
    }

    public function testComposerVerifiesTheArchiveBeforeExtraction(): void
    {
        $io = new NullIO();
        $config = new Config(false, $this->directory);
        $config->merge(['config' => ['vendor-dir' => $this->directory . '/vendor']]);
        $context = new PartialComposer();
        $context->setConfig($config);
        $context->setPackage(new RootPackage('fixture/root', '1.0.0.0', '1.0.0'));
        $dispatcher = new EventDispatcher($context, $io);
        $dispatcher->setRunScripts(false);
        $dispatcher->addSubscriber($this->plugin);
        foreach ([false, true] as $trusted) {
            file_put_contents($this->directory . '/archive.zip', $trusted ? 'verified archive bytes' : 'tampered');
            $http = new HttpDownloader($io, $config);
            $loop = new Loop($http);
            $archive = new class ($io, $config, $http, $dispatcher) extends ArchiveDownloader {
                public bool $extracted = false;
                protected function extract(PackageInterface $package, string $file, string $path): PromiseInterface
                {
                    $this->extracted = true;
                    if (!is_dir($path)) {
                        mkdir($path, 0o700, true);
                    }
                    file_put_contents($path . '/payload.txt', file_get_contents($file) ?: throw new RuntimeException('Missing fixture archive'));
                    return \React\Promise\resolve(null);
                }
            };
            $this->downloads->setDownloader('zip', $archive);
            $file = str_replace('\\', '/', $this->directory . '/archive.zip');
            $package = $this->downloadPackage('file://' . (str_starts_with($file, '/') ? '' : '/') . $file);
            $destination = $this->directory . ($trusted ? '/trusted-install' : '/rejected-install');
            $failure = null;
            try {
                $loop->wait([$this->downloads->download($package, $destination)->then(
                    fn(): PromiseInterface => $this->downloads->install($package, $destination),
                )]);
            } catch (RuntimeException $error) {
                $failure = $error;
            }
            self::assertSame($trusted, $archive->extracted);
            if ($trusted) {
                self::assertNull($failure);
                self::assertSame('verified archive bytes', file_get_contents($destination . '/payload.txt'));
            } else {
                self::assertInstanceOf(RuntimeException::class, $failure);
                self::assertStringContainsString('Missing or mismatched trusted Composer SHA-256', $failure->getMessage());
                self::assertSame(['.', '..'], scandir($destination));
            }
        }
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
