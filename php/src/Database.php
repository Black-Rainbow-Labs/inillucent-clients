<?php

declare(strict_types=1);

namespace Inillucent;

/**
 * One open database file.
 *
 * One file is one buffer pool and the engine is single threaded, so keep a
 * Database and everything under it in one process. There is no lock inside. Two
 * databases on two files are independent.
 */
final class Database
{
    private const OPEN_CREATE = 0x0001;
    private const OPEN_READONLY = 0x0002;
    private const OPEN_DIAGNOSTICS = 0x0004;

    /** @var Connection[] */
    private array $connections = [];
    private mixed $handle;

    private function __construct(mixed $handle)
    {
        $this->handle = $handle;
    }

    /**
     * Opens a database file, creating it when it is not there.
     *
     * @param string $path the database file
     * @param bool $create create the file when it is not there
     * @param bool $readOnly refuse anything but a query
     * @param bool $diagnostics collect internal diagnostic text on failures, which
     *        may hold a path or a bound value and so must not be shown to a person
     */
    public static function open(
        string $path,
        bool $create = true,
        bool $readOnly = false,
        bool $diagnostics = false,
    ): self {
        $ffi = Driver::ffi();
        $flags = 0;
        if ($create) {
            $flags |= self::OPEN_CREATE;
        }
        if ($readOnly) {
            $flags |= self::OPEN_READONLY;
        }
        if ($diagnostics) {
            $flags |= self::OPEN_DIAGNOSTICS;
        }
        $out = $ffi->new('inillucent_db*[1]');
        $error = $ffi->new('inillucent_error*[1]');
        InillucentException::check($ffi->inillucent_open($path, $flags, $out, $error), $error);
        return new self($out[0]);
    }

    /** Opens a connection, and with it a session. */
    public function connect(): Connection
    {
        $ffi = Driver::ffi();
        $out = $ffi->new('inillucent_conn*[1]');
        $error = $ffi->new('inillucent_error*[1]');
        InillucentException::check($ffi->inillucent_connect($this->handle, $out, $error), $error);
        $connection = new Connection($this, $out[0]);
        $this->connections[] = $connection;
        return $connection;
    }

    /** Returns the file this database is in. */
    public function path(): string
    {
        return Driver::readString(Driver::ffi()->inillucent_path($this->handle)) ?? '';
    }

    /** Makes everything written so far durable in the file. */
    public function checkpoint(): void
    {
        $this->simple('inillucent_checkpoint');
    }

    /** Walks every tree and throws on the first thing that is wrong. */
    public function integrityCheck(): void
    {
        $this->simple('inillucent_integrity_check');
    }

    /**
     * Copies the database to a path, opening and checking the copy first.
     *
     * A backup nobody checked is a file that is assumed to be a database.
     *
     * @param string $path where to write the copy
     */
    public function backupTo(string $path): void
    {
        $ffi = Driver::ffi();
        $error = $ffi->new('inillucent_error*[1]');
        InillucentException::check(
            $ffi->inillucent_backup_to($this->handle, $path, $error),
            $error
        );
    }

    /**
     * Runs one of the calls that take only the database and an error.
     *
     * @param string $name the symbol to call
     */
    private function simple(string $name): void
    {
        $ffi = Driver::ffi();
        $error = $ffi->new('inillucent_error*[1]');
        InillucentException::check($ffi->$name($this->handle, $error), $error);
    }

    /**
     * Checkpoints and closes, closing every connection first.
     *
     * The C library refuses to close a database that still has connections on
     * it, which is deliberate: freeing it then would leave them pointing at
     * memory that is gone. Closing twice is safe.
     */
    public function close(): void
    {
        if ($this->handle === null) {
            return;
        }
        foreach ($this->connections as $connection) {
            $connection->close();
        }
        $this->connections = [];
        $closing = $this->handle;
        $this->handle = null;
        $ffi = Driver::ffi();
        $error = $ffi->new('inillucent_error*[1]');
        InillucentException::check($ffi->inillucent_close($closing, $error), $error);
    }
}
