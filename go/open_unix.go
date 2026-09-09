//go:build !windows

package inillucent

import "github.com/ebitengine/purego"

// openLibrary loads the shared library on Linux and macOS.
//
// RTLD_GLOBAL is asked for so a symbol the driver itself needs later resolves,
// and RTLD_NOW makes a missing one a failure here rather than at the call.
//
// @param path - the shared library file
func openLibrary(path string) (uintptr, error) {
	return purego.Dlopen(path, purego.RTLD_NOW|purego.RTLD_GLOBAL)
}
