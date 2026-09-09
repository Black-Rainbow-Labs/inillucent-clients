package inillucent

import (
	"fmt"
	"unsafe"
)

// Support says whether the engine does something.
type Support int32

const (
	SupportNo Support = 0
	// SupportYes means the engine does it.
	SupportYes Support = 1
	// SupportPartial means yes, with the limit the note names. A caller that
	// treats it as SupportYes without reading the note will be surprised.
	SupportPartial Support = -1
	// SupportUnknown means no such capability in this build. Treat it as no
	// rather than as yes: one that was never declared was certainly never
	// checked.
	SupportUnknown Support = -2
)

// String returns the support state as a word.
func (support Support) String() string {
	switch support {
	case SupportNo:
		return "no"
	case SupportYes:
		return "yes"
	case SupportPartial:
		return "partial"
	default:
		return "unknown"
	}
}

// IsSupported reports whether the engine will do this at all.
//
// Partial counts, and the note says how far.
func (support Support) IsSupported() bool {
	return support == SupportYes || support == SupportPartial
}

// Capability is one row of the engine's capability table.
type Capability struct {
	Name    string
	Support Support
	Note    string
}

// Capabilities returns every capability the engine declares.
//
// Ask this before composing a statement rather than after. Every row is checked
// against the running engine by a test in both directions, so a claim of support
// that fails and a claim of absence that now works each turn it red.
func Capabilities() ([]Capability, error) {
	calls, err := driver()
	if err != nil {
		return nil, err
	}
	count := calls.capabilityCount()
	found := make([]Capability, 0, count)
	for nth := uintptr(0); nth < count; nth++ {
		var name, note unsafe.Pointer
		var state int32
		if calls.capability(nth, &name, &state, &note) != 0 {
			continue
		}
		readName, _ := goString(name)
		readNote, _ := goString(note)
		found = append(found, Capability{
			Name:    readName,
			Support: Support(state),
			Note:    readNote,
		})
	}
	return found, nil
}

// Supports returns whether the engine does something, by name.
//
// @param name - the capability name
func Supports(name string) (Support, error) {
	calls, err := driver()
	if err != nil {
		return SupportUnknown, err
	}
	return Support(calls.supports(name)), nil
}

// Version returns what the driver calls itself.
func Version() (string, error) {
	calls, err := driver()
	if err != nil {
		return "", err
	}
	found, _ := goString(calls.version())
	return found, nil
}

// ABIVersion returns the shared library's ABI version as major.minor.patch.
func ABIVersion() (string, error) {
	calls, err := driver()
	if err != nil {
		return "", err
	}
	reported := calls.abiVersion()
	return fmt.Sprintf("%d.%d.%d", reported/1_000_000, (reported/1000)%1000, reported%1000), nil
}

// DriverPath returns the file the shared library was loaded from.
func DriverPath() (string, error) {
	calls, err := driver()
	if err != nil {
		return "", err
	}
	return calls.path, nil
}
