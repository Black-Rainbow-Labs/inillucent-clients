<?php

declare(strict_types=1);

namespace Inillucent;

/**
 * The engine has not implemented the construct.
 *
 * This is a separate type on purpose. The engine refuses what it has not built
 * rather than answering it wrongly, so an application can say "this engine
 * cannot do that yet" instead of "check your spelling". The feature property
 * names the construct that was refused.
 */
final class UnsupportedFeatureException extends InillucentException
{
}
