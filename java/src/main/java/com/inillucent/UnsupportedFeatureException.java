package com.inillucent;

/**
 * The engine has not implemented the construct.
 *
 * This is a separate type on purpose. The engine refuses what it has not built
 * rather than answering it wrongly, so an application can say "this engine
 * cannot do that yet" instead of "check your spelling". {@link #feature()} names
 * the construct that was refused.
 */
public class UnsupportedFeatureException extends InillucentException {

    UnsupportedFeatureException(Status status, String message, String feature, String detail,
                                int offset) {
        super(status, message, feature, detail, offset);
    }
}
