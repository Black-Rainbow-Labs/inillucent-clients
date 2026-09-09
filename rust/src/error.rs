//! Failures the engine reports, and the status codes behind them.

use std::fmt;

/// What a call returned.
///
/// `Unsupported` is a status of its own. The engine refuses what it has not
/// built rather than answering it wrongly, so an application can say "this
/// engine cannot do that yet" instead of "check your spelling".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Ok,
    Unsupported,
    Syntax,
    NotFound,
    Constraint,
    ReadOnly,
    Busy,
    Interrupted,
    Corrupt,
    Io,
    Full,
    TooBig,
    InvalidState,
    Internal,
    /// A code this version has never heard of, kept rather than folded into
    /// `Internal` so a newer engine's refusal is not misreported.
    Other(i32),
}

impl Status {
    /// Returns the status a C status code names.
    ///
    /// @param code - the integer the C ABI returned
    pub fn from_code(code: i32) -> Self {
        match code {
            0 => Status::Ok,
            1 => Status::Unsupported,
            2 => Status::Syntax,
            3 => Status::NotFound,
            4 => Status::Constraint,
            5 => Status::ReadOnly,
            6 => Status::Busy,
            7 => Status::Interrupted,
            8 => Status::Corrupt,
            9 => Status::Io,
            10 => Status::Full,
            11 => Status::TooBig,
            12 => Status::InvalidState,
            13 => Status::Internal,
            other => Status::Other(other),
        }
    }

    /// Returns the status as the name the conformance suite uses.
    pub fn name(self) -> &'static str {
        match self {
            Status::Ok => "ok",
            Status::Unsupported => "unsupported",
            Status::Syntax => "syntax",
            Status::NotFound => "not_found",
            Status::Constraint => "constraint",
            Status::ReadOnly => "readonly",
            Status::Busy => "busy",
            Status::Interrupted => "interrupted",
            Status::Corrupt => "corrupt",
            Status::Io => "io",
            Status::Full => "full",
            Status::TooBig => "too_big",
            Status::InvalidState => "invalid_state",
            Status::Internal => "internal",
            Status::Other(_) => "unknown",
        }
    }
}

/// Something the engine refused.
///
/// It carries the status, not only the message, because a caller that has to
/// match on prose to find out what happened will break the first time the
/// wording improves.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error {
    pub status: Status,
    pub message: String,
    /// The construct the engine has not implemented, when the status is
    /// `Unsupported`. It is finer grained than the capability table on purpose.
    pub feature: Option<String>,
    /// Internal diagnostic text, present only when the database was opened with
    /// diagnostics. It may hold a path or a bound value, so do not show it to a
    /// person and do not send it to a shared log.
    pub detail: Option<String>,
    /// The byte offset into the statement, when the failure has one.
    pub offset: Option<i32>,
}

impl Error {
    /// Returns whether this is the engine refusing something it has not built.
    ///
    /// Match on this rather than on the message, and read `feature` for the name
    /// of the construct.
    pub fn is_unsupported(&self) -> bool {
        self.status == Status::Unsupported
    }
}

impl fmt::Display for Error {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(out, "{} [{}]", self.message, self.status.name())?;
        if let Some(offset) = self.offset {
            write!(out, " at byte {offset}")?;
        }
        Ok(())
    }
}

impl std::error::Error for Error {}

/// The shared library could not be found, loaded, or matched to this crate's ABI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadError(pub String);

impl fmt::Display for LoadError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(&self.0)
    }
}

impl std::error::Error for LoadError {}

impl From<LoadError> for Error {
    fn from(why: LoadError) -> Self {
        Error {
            status: Status::Internal,
            message: why.0,
            feature: None,
            detail: None,
            offset: None,
        }
    }
}

/// What every call in this crate returns.
pub type Result<T> = std::result::Result<T, Error>;
