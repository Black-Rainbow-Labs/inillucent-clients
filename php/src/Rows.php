<?php

declare(strict_types=1);

namespace Inillucent;

use ArrayIterator;
use Countable;
use FFI;
use IteratorAggregate;
use Traversable;

/**
 * Everything one statement produced.
 *
 * The engine materialises the result and this copies it into PHP, so the object
 * stays usable after the C handle is freed. That is what lets it be returned
 * from a function and read later.
 *
 * A cell is null, int, float, string or Blob. Null means NULL, which is not the
 * empty string, and a Blob is bytes rather than text.
 *
 * @implements IteratorAggregate<int, array<int, mixed>>
 */
final class Rows implements Countable, IteratorAggregate
{
    /**
     * @param string[] $columns the result column names, in order
     * @param string[] $columnTypes the declared type of each column, or "" for an expression
     * @param array<int, array<int, mixed>> $rows every row handed back, in order
     * @param int $total how many rows the statement produced, exactly
     * @param bool $more whether the limit cut anything off
     * @param int|null $affected rows changed, or null for a statement that changed nothing
     * @param int $elapsedMicros how long the engine spent on it
     * @param string $tag a one line summary for a status bar, such as "SELECT 27"
     */
    private function __construct(
        public readonly array $columns,
        public readonly array $columnTypes,
        public readonly array $rows,
        public readonly int $total,
        public readonly bool $more,
        public readonly ?int $affected,
        public readonly int $elapsedMicros,
        public readonly string $tag,
    ) {
    }

    /**
     * Copies a C result into PHP and frees the handle.
     *
     * @param mixed $handle the C result handle, which is owned by this call
     */
    public static function take(mixed $handle): self
    {
        $ffi = Driver::ffi();
        try {
            $count = $ffi->inillucent_rows_column_count($handle);
            $columns = [];
            $columnTypes = [];
            for ($nth = 0; $nth < $count; $nth++) {
                $columns[] = Driver::readString(
                    $ffi->inillucent_rows_column_name($handle, $nth)
                ) ?? '';
                $columnTypes[] = Driver::readString(
                    $ffi->inillucent_rows_column_type($handle, $nth)
                ) ?? '';
            }

            $handed = $ffi->inillucent_rows_count($handle);
            $rows = [];
            for ($row = 0; $row < $handed; $row++) {
                $cells = [];
                for ($column = 0; $column < $count; $column++) {
                    $cells[] = self::readCell($handle, $row, $column);
                }
                $rows[] = $cells;
            }

            $changed = $ffi->inillucent_rows_affected($handle);
            return new self(
                $columns,
                $columnTypes,
                $rows,
                $ffi->inillucent_rows_total($handle),
                $ffi->inillucent_rows_more($handle) !== 0,
                $changed < 0 ? null : $changed,
                $ffi->inillucent_rows_elapsed_us($handle),
                Driver::readString($ffi->inillucent_rows_tag($handle)) ?? ''
            );
        } finally {
            $ffi->inillucent_rows_free($handle);
        }
    }

    /**
     * Reads one cell as the kind it actually is.
     *
     * Text is not NUL terminated and may contain a NUL byte, so the length is
     * read rather than the bytes scanned.
     *
     * @param mixed $handle the C result handle
     * @param int $row the row index
     * @param int $column the column index
     */
    private static function readCell(mixed $handle, int $row, int $column): mixed
    {
        $ffi = Driver::ffi();
        $kind = $ffi->inillucent_value_type($handle, $row, $column);
        if ($kind === 0) {
            return null;
        }
        if ($kind === 1) {
            return $ffi->inillucent_value_int($handle, $row, $column);
        }
        if ($kind === 2) {
            return $ffi->inillucent_value_real($handle, $row, $column);
        }
        $length = $ffi->new('size_t[1]');
        $pointer = $ffi->inillucent_value_bytes($handle, $row, $column, $length);
        $bytes = FFI::isNull($pointer) || $length[0] === 0
            ? ''
            : FFI::string(FFI::cast('char*', $pointer), $length[0]);
        return $kind === 3 ? $bytes : new Blob($bytes);
    }

    /**
     * Returns every row as an array keyed by column name.
     *
     * A duplicate column name would silently lose a value, so the later one wins
     * and a caller who needs both reads $rows instead.
     *
     * @return array<int, array<string, mixed>>
     */
    public function objects(): array
    {
        $out = [];
        foreach ($this->rows as $row) {
            $object = [];
            foreach ($this->columns as $nth => $name) {
                $object[$name] = $row[$nth] ?? null;
            }
            $out[] = $object;
        }
        return $out;
    }

    /**
     * Returns the first row, or null when the statement produced none.
     *
     * @return array<int, mixed>|null
     */
    public function one(): ?array
    {
        return $this->rows[0] ?? null;
    }

    /**
     * Returns the first column of the first row, or null when there is none.
     *
     * This is the shape of a COUNT or a MAX, where unwrapping one value out of
     * two arrays is a cost the caller pays on every line.
     */
    public function scalar(): mixed
    {
        return $this->rows[0][0] ?? null;
    }

    /**
     * Returns the position of a column by name, or null when there is none.
     *
     * @param string $name the column name to look for
     */
    public function columnIndex(string $name): ?int
    {
        $found = array_search($name, $this->columns, true);
        return $found === false ? null : $found;
    }

    /**
     * Returns one cell by row index and column name.
     *
     * @param int $row the row index
     * @param string $name the column name
     */
    public function get(int $row, string $name): mixed
    {
        $column = $this->columnIndex($name);
        if ($column === null) {
            return null;
        }
        return $this->rows[$row][$column] ?? null;
    }

    /** Returns how many rows were handed back. */
    public function count(): int
    {
        return count($this->rows);
    }

    /** Walks the rows in the order the engine produced them. */
    public function getIterator(): Traversable
    {
        return new ArrayIterator($this->rows);
    }
}
