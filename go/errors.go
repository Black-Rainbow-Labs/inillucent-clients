package inillucent

// Status is what a call returned.
//
// StatusUnsupported is a status of its own. The engine refuses what it has not
// built rather than answering it wrongly, so an application can say "this engine
// cannot do that yet" instead of "check your spelling".
type Status int32

const (
	StatusOK           Status = 0
	StatusUnsupported  Status = 1
	StatusSyntax       Status = 2
	StatusNotFound     Status = 3
	StatusConstraint   Status = 4
	StatusReadOnly     Status = 5
	StatusBusy         Status = 6
	StatusInterrupted  Status = 7
	StatusCorrupt      Status = 8
	StatusIO           Status = 9
	StatusFull         Status = 10
	StatusTooBig       Status = 11
	StatusInvalidState Status = 12
	StatusInternal     Status = 13
)

var statusNames = map[Status]string{
	StatusOK:           "ok",
	StatusUnsupported:  "unsupported",
	StatusSyntax:       "syntax",
	StatusNotFound:     "not_found",
	StatusConstraint:   "constraint",
	StatusReadOnly:     "readonly",
	StatusBusy:         "busy",
	StatusInterrupted:  "interrupted",
	StatusCorrupt:      "corrupt",
	StatusIO:           "io",
	StatusFull:         "full",
	StatusTooBig:       "too_big",
	StatusInvalidState: "invalid_state",
	StatusInternal:     "internal",
}

// String returns the status as the name the conformance suite uses.
func (status Status) String() string {
	if name, known := statusNames[status]; known {
		return name
	}
	return "unknown"
}

// Error is something the engine refused.
//
// It carries the status, not only the message, because a caller that has to
// match on prose to find out what happened will break the first time the wording
// improves.
type Error struct {
	Status  Status
	Message string
	// Feature is the construct the engine has not implemented, when the status
	// is StatusUnsupported. It is finer grained than the capability table on
	// purpose, so an application can name what it hit.
	Feature string
	// Detail is internal diagnostic text, present only when the database was
	// opened with Diagnostics. It may hold a path or a bound value, so do not
	// show it to a person and do not send it to a shared log.
	Detail string
	// Offset is the byte offset into the statement, or -1 when there is none.
	Offset int32
}

// Error returns the message, the status name, and the offset when there is one.
func (why *Error) Error() string {
	said := why.Message + " [" + why.Status.String() + "]"
	if why.Offset >= 0 {
		said += " at byte " + itoa(int(why.Offset))
	}
	return said
}

// IsUnsupported reports whether this is the engine refusing something it has not
// built.
//
// Check this rather than the message, and read Feature for the name of the
// construct that was refused.
func (why *Error) IsUnsupported() bool {
	return why.Status == StatusUnsupported
}

// itoa renders a non negative int without pulling in strconv, which keeps the
// error path free of anything that could itself fail.
func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	digits := [20]byte{}
	at := len(digits)
	for value > 0 {
		at--
		digits[at] = byte('0' + value%10)
		value /= 10
	}
	return string(digits[at:])
}

// errorFrom builds the error a C error handle describes, and frees it either way.
//
// The free happens whatever the outcome because an error built from a handle must
// not leak it.
//
// @param calls - the driver call table
// @param handle - the C error handle, which is owned by this call
func errorFrom(calls *driverCalls, handle uintptr) *Error {
	message, _ := goString(calls.errorMessage(handle))
	feature, _ := goString(calls.errorFeature(handle))
	detail, _ := goString(calls.errorDetail(handle))
	built := &Error{
		Status:  Status(calls.errorStatus(handle)),
		Message: message,
		Feature: feature,
		Detail:  detail,
		Offset:  calls.errorOffset(handle),
	}
	calls.errorFree(handle)
	return built
}

// check turns a failed call into an error, using the error it produced.
//
// A non zero status with no error still fails: a call that failed and said
// nothing is not a reason to carry on.
//
// @param calls - the driver call table
// @param status - what the call returned
// @param handle - the error out parameter the call was given
func check(calls *driverCalls, status int32, handle uintptr) error {
	if status == 0 {
		return nil
	}
	if handle != 0 {
		return errorFrom(calls, handle)
	}
	return &Error{
		Status:  Status(status),
		Message: "the call failed with " + Status(status).String(),
		Offset:  -1,
	}
}
