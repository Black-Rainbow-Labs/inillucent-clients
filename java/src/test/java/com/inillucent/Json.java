package com.inillucent;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * A small JSON reader, so the conformance runner needs no dependency.
 *
 * The client library itself parses no JSON. This lives in the test sources only,
 * because the alternative is putting a JSON library on the classpath of anybody
 * who wants to run the suite, and the suite is meant to be easy to run.
 *
 * It produces Map, List, String, Long, Double, Boolean and null.
 */
final class Json {

    private final String text;
    private int at;

    private Json(String text) {
        this.text = text;
    }

    /**
     * Parses a JSON document.
     *
     * @param text - the document
     */
    static Object parse(String text) {
        Json reader = new Json(text);
        reader.skipSpace();
        Object value = reader.readValue();
        reader.skipSpace();
        if (reader.at != text.length()) {
            throw new IllegalArgumentException("trailing text at byte " + reader.at);
        }
        return value;
    }

    /** Reads whatever value starts at the cursor. */
    private Object readValue() {
        char here = text.charAt(at);
        switch (here) {
            case '{':
                return readObject();
            case '[':
                return readArray();
            case '"':
                return readString();
            case 't':
                expect("true");
                return Boolean.TRUE;
            case 'f':
                expect("false");
                return Boolean.FALSE;
            case 'n':
                expect("null");
                return null;
            default:
                return readNumber();
        }
    }

    /** Reads an object, keeping the key order the file used. */
    private Map<String, Object> readObject() {
        Map<String, Object> object = new LinkedHashMap<>();
        at++;
        skipSpace();
        if (text.charAt(at) == '}') {
            at++;
            return object;
        }
        while (true) {
            skipSpace();
            String key = readString();
            skipSpace();
            require(':');
            skipSpace();
            object.put(key, readValue());
            skipSpace();
            char next = text.charAt(at++);
            if (next == '}') {
                return object;
            }
            if (next != ',') {
                throw new IllegalArgumentException("expected , or } at byte " + (at - 1));
            }
        }
    }

    /** Reads an array. */
    private List<Object> readArray() {
        List<Object> values = new ArrayList<>();
        at++;
        skipSpace();
        if (text.charAt(at) == ']') {
            at++;
            return values;
        }
        while (true) {
            skipSpace();
            values.add(readValue());
            skipSpace();
            char next = text.charAt(at++);
            if (next == ']') {
                return values;
            }
            if (next != ',') {
                throw new IllegalArgumentException("expected , or ] at byte " + (at - 1));
            }
        }
    }

    /** Reads a string, including its escapes. */
    private String readString() {
        require('"');
        StringBuilder built = new StringBuilder();
        while (true) {
            char here = text.charAt(at++);
            if (here == '"') {
                return built.toString();
            }
            if (here != '\\') {
                built.append(here);
                continue;
            }
            char escaped = text.charAt(at++);
            switch (escaped) {
                case '"' -> built.append('"');
                case '\\' -> built.append('\\');
                case '/' -> built.append('/');
                case 'b' -> built.append('\b');
                case 'f' -> built.append('\f');
                case 'n' -> built.append('\n');
                case 'r' -> built.append('\r');
                case 't' -> built.append('\t');
                case 'u' -> {
                    built.append((char) Integer.parseInt(text.substring(at, at + 4), 16));
                    at += 4;
                }
                default -> throw new IllegalArgumentException(
                    "unknown escape \\" + escaped + " at byte " + (at - 1));
            }
        }
    }

    /**
     * Reads a number as a Long when it is whole and a Double when it is not.
     *
     * The distinction matters here: the suite says {"int": 7} and {"real": 0.5}
     * for values whose kinds are different in the engine, and a reader that made
     * everything a double would erase that before the comparison saw it.
     */
    private Object readNumber() {
        int start = at;
        while (at < text.length() && "+-0123456789.eE".indexOf(text.charAt(at)) >= 0) {
            at++;
        }
        String number = text.substring(start, at);
        if (number.indexOf('.') < 0 && number.indexOf('e') < 0 && number.indexOf('E') < 0) {
            return Long.parseLong(number);
        }
        return Double.parseDouble(number);
    }

    /** Skips whitespace. */
    private void skipSpace() {
        while (at < text.length() && Character.isWhitespace(text.charAt(at))) {
            at++;
        }
    }

    /**
     * Consumes one expected character.
     *
     * @param wanted - the character that must be here
     */
    private void require(char wanted) {
        if (text.charAt(at) != wanted) {
            throw new IllegalArgumentException(
                "expected " + wanted + " at byte " + at + " and found " + text.charAt(at));
        }
        at++;
    }

    /**
     * Consumes one expected literal.
     *
     * @param wanted - the literal that must be here
     */
    private void expect(String wanted) {
        if (!text.startsWith(wanted, at)) {
            throw new IllegalArgumentException("expected " + wanted + " at byte " + at);
        }
        at += wanted.length();
    }
}
