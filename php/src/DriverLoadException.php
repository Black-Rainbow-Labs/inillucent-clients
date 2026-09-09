<?php

declare(strict_types=1);

namespace Inillucent;

use RuntimeException;

/** The shared library could not be found, loaded, or matched to this package's ABI. */
final class DriverLoadException extends RuntimeException
{
}
