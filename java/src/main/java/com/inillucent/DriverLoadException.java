package com.inillucent;

/** The shared library could not be found, loaded, or matched to this package's ABI. */
public class DriverLoadException extends RuntimeException {

    public DriverLoadException(String message) {
        super(message);
    }
}
