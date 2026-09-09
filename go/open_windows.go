//go:build windows

package inillucent

import "syscall"

// openLibrary loads the shared library on Windows.
//
// purego has no Dlopen on Windows, so the handle comes from LoadLibrary, which
// is what purego's own Windows path expects to be given.
//
// @param path - the shared library file
func openLibrary(path string) (uintptr, error) {
	handle, err := syscall.LoadLibrary(path)
	if err != nil {
		return 0, err
	}
	return uintptr(handle), nil
}
