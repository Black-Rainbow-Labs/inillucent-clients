//! What the engine says it can do, and how to ask before composing a statement.

use std::ffi::{c_char, CString};

use crate::error::LoadError;
use crate::ffi::{driver, owned};

/// Whether the engine does something.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Support {
    No,
    Yes,
    /// Yes, with the limit the note names. A caller that treats this as `Yes`
    /// without reading the note will be surprised.
    Partial,
    /// No such capability in this build.
    ///
    /// Treat it as no rather than as yes: one that was never declared was
    /// certainly never checked.
    Unknown,
}

impl Support {
    /// Returns the support state a C value names.
    ///
    /// @param code - the integer the C ABI returned
    pub fn from_code(code: i32) -> Self {
        match code {
            0 => Support::No,
            1 => Support::Yes,
            -1 => Support::Partial,
            _ => Support::Unknown,
        }
    }

    /// Returns the state as a word.
    pub fn name(self) -> &'static str {
        match self {
            Support::No => "no",
            Support::Yes => "yes",
            Support::Partial => "partial",
            Support::Unknown => "unknown",
        }
    }

    /// Returns whether the engine will do this at all.
    ///
    /// Partial counts, and the note says how far.
    pub fn is_supported(self) -> bool {
        matches!(self, Support::Yes | Support::Partial)
    }
}

/// One row of the engine's capability table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Capability {
    pub name: String,
    pub support: Support,
    pub note: String,
}

/// Returns every capability the engine declares.
///
/// Ask this before composing a statement rather than after. Every row is checked
/// against the running engine by a test in both directions, so a claim of
/// support that fails and a claim of absence that now works each turn it red.
pub fn capabilities() -> Result<Vec<Capability>, LoadError> {
    let calls = driver()?;
    let count = unsafe { (calls.capability_count)() };
    let mut found = Vec::with_capacity(count);
    for nth in 0..count {
        let mut name: *const c_char = std::ptr::null();
        let mut state: i32 = 0;
        let mut note: *const c_char = std::ptr::null();
        unsafe {
            if (calls.capability)(nth, &mut name, &mut state, &mut note) != 0 {
                continue;
            }
            found.push(Capability {
                name: owned(name).unwrap_or_default(),
                support: Support::from_code(state),
                note: owned(note).unwrap_or_default(),
            });
        }
    }
    Ok(found)
}

/// Returns whether the engine does something, by name.
///
/// @param name - the capability name
pub fn supports(name: &str) -> Result<Support, LoadError> {
    let calls = driver()?;
    let text = CString::new(name)
        .map_err(|_| LoadError("a capability name may not contain a NUL byte".to_owned()))?;
    Ok(Support::from_code(unsafe { (calls.supports)(text.as_ptr()) }))
}

/// Returns what the driver calls itself.
pub fn version() -> Result<String, LoadError> {
    let calls = driver()?;
    Ok(unsafe { owned((calls.version)()) }.unwrap_or_default())
}

/// Returns the shared library's ABI version as major.minor.patch.
pub fn abi_version() -> Result<String, LoadError> {
    let calls = driver()?;
    let reported = unsafe { (calls.abi_version)() };
    Ok(format!("{}.{}.{}", reported / 1_000_000, (reported / 1000) % 1000, reported % 1000))
}

/// Returns the file the shared library was loaded from.
pub fn driver_path() -> Result<String, LoadError> {
    Ok(driver()?.path.display().to_string())
}
