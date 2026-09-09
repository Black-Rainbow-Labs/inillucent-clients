<?php

declare(strict_types=1);

/**
 * Loads this package's classes without Composer.
 *
 * A published install uses Composer's autoloader; this file is what lets the
 * conformance runner and the examples work straight out of a checkout, so
 * running the suite needs nothing installed.
 */
spl_autoload_register(static function (string $class): void {
    $prefix = 'Inillucent\\';
    if (!str_starts_with($class, $prefix)) {
        return;
    }
    $relative = substr($class, strlen($prefix));
    $path = __DIR__ . '/src/' . str_replace('\\', '/', $relative) . '.php';
    if (is_file($path)) {
        require $path;
    }
});
