//! The values the engine stores, and one materialised result.

use std::ffi::c_void;
use std::fmt;

use crate::error::Result;
use crate::ffi::{driver, owned};

/// One value, as the engine stores it.
///
/// `Null` is a variant rather than an empty string, because they are different
/// values and a layer that drew them the same is a layer nobody can trust.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Null,
    Integer(i64),
    Real(f64),
    Text(String),
    Blob(Vec<u8>),
}

impl Value {
    /// Returns the integer this value holds, or None when it is another kind.
    pub fn as_integer(&self) -> Option<i64> {
        match self {
            Value::Integer(whole) => Some(*whole),
            _ => None,
        }
    }

    /// Returns the real this value holds, or None when it is another kind.
    pub fn as_real(&self) -> Option<f64> {
        match self {
            Value::Real(number) => Some(*number),
            _ => None,
        }
    }

    /// Returns the text this value holds, or None when it is another kind.
    pub fn as_text(&self) -> Option<&str> {
        match self {
            Value::Text(text) => Some(text),
            _ => None,
        }
    }

    /// Returns the bytes this value holds, or None when it is another kind.
    pub fn as_blob(&self) -> Option<&[u8]> {
        match self {
            Value::Blob(bytes) => Some(bytes),
            _ => None,
        }
    }

    /// Returns whether this value is NULL.
    pub fn is_null(&self) -> bool {
        matches!(self, Value::Null)
    }
}

impl fmt::Display for Value {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Value::Null => out.write_str("NULL"),
            Value::Integer(whole) => write!(out, "{whole}"),
            Value::Real(number) => write!(out, "{number}"),
            Value::Text(text) => out.write_str(text),
            Value::Blob(bytes) => write!(out, "{} bytes", bytes.len()),
        }
    }
}

impl From<i64> for Value {
    fn from(whole: i64) -> Self {
        Value::Integer(whole)
    }
}

impl From<i32> for Value {
    fn from(whole: i32) -> Self {
        Value::Integer(i64::from(whole))
    }
}

impl From<f64> for Value {
    fn from(number: f64) -> Self {
        Value::Real(number)
    }
}

impl From<bool> for Value {
    fn from(yes: bool) -> Self {
        Value::Integer(i64::from(yes))
    }
}

impl From<&str> for Value {
    fn from(text: &str) -> Self {
        Value::Text(text.to_owned())
    }
}

impl From<String> for Value {
    fn from(text: String) -> Self {
        Value::Text(text)
    }
}

impl From<Vec<u8>> for Value {
    fn from(bytes: Vec<u8>) -> Self {
        Value::Blob(bytes)
    }
}

impl From<&[u8]> for Value {
    fn from(bytes: &[u8]) -> Self {
        Value::Blob(bytes.to_vec())
    }
}

impl<T: Into<Value>> From<Option<T>> for Value {
    fn from(maybe: Option<T>) -> Self {
        match maybe {
            Some(value) => value.into(),
            None => Value::Null,
        }
    }
}

/// Reads one cell out of a result as the kind it actually is.
///
/// Text is not NUL terminated and may contain a NUL byte, so the length is read
/// rather than the bytes scanned.
///
/// # Safety
/// The caller states that `handle` is a live result and the indices are inside it.
unsafe fn read_cell(handle: *const c_void, row: usize, column: usize) -> Result<Value> {
    let calls = driver()?;
    let kind = (calls.value_type)(handle, row, column);
    Ok(match kind {
        0 => Value::Null,
        1 => Value::Integer((calls.value_int)(handle, row, column)),
        2 => Value::Real((calls.value_real)(handle, row, column)),
        _ => {
            let mut length: usize = 0;
            let pointer = (calls.value_bytes)(handle, row, column, &mut length);
            if pointer.is_null() {
                Value::Null
            } else {
                let bytes = std::slice::from_raw_parts(pointer, length).to_vec();
                if kind == 3 {
                    Value::Text(String::from_utf8_lossy(&bytes).into_owned())
                } else {
                    Value::Blob(bytes)
                }
            }
        }
    })
}

/// Everything one statement produced.
///
/// The engine materialises the result and this copies it into Rust, so it stays
/// usable after the C handle is freed.
#[derive(Debug, Clone)]
pub struct Rows {
    /// The result column names, in order.
    pub columns: Vec<String>,
    /// The type each column was declared with, or an empty string for an
    /// expression, which has none.
    pub column_types: Vec<String>,
    /// Every row handed back, in order.
    pub rows: Vec<Vec<Value>>,
    /// How many rows the statement produced, exactly.
    ///
    /// The engine materialises, so this was counted rather than estimated, which
    /// is what lets a grid say "1 to 200 of 4,317" and mean it.
    pub total: usize,
    /// Whether the limit cut anything off.
    pub more: bool,
    /// Rows changed, or None for a statement that changed nothing.
    pub affected: Option<i64>,
    /// How long the engine spent on it.
    pub elapsed_micros: u64,
    /// A one line summary for a status bar, such as "SELECT 27".
    pub tag: String,
}

impl Rows {
    /// Copies a C result into Rust and frees the handle.
    ///
    /// # Safety
    /// The caller states that `handle` is a live result this call takes over.
    pub(crate) unsafe fn take(handle: *mut c_void) -> Result<Self> {
        let calls = driver()?;
        let read = || -> Result<Rows> {
            let count = (calls.rows_column_count)(handle);
            let mut columns = Vec::with_capacity(count);
            let mut column_types = Vec::with_capacity(count);
            for nth in 0..count {
                columns.push(owned((calls.rows_column_name)(handle, nth)).unwrap_or_default());
                column_types.push(owned((calls.rows_column_type)(handle, nth)).unwrap_or_default());
            }
            let handed = (calls.rows_count)(handle);
            let mut rows = Vec::with_capacity(handed);
            for row in 0..handed {
                let mut cells = Vec::with_capacity(count);
                for column in 0..count {
                    cells.push(read_cell(handle, row, column)?);
                }
                rows.push(cells);
            }
            let changed = (calls.rows_affected)(handle);
            Ok(Rows {
                columns,
                column_types,
                rows,
                total: (calls.rows_total)(handle),
                more: (calls.rows_more)(handle) != 0,
                affected: if changed < 0 { None } else { Some(changed) },
                elapsed_micros: (calls.rows_elapsed_us)(handle),
                tag: owned((calls.rows_tag)(handle)).unwrap_or_default(),
            })
        };
        let read = read();
        (calls.rows_free)(handle);
        read
    }

    /// How many rows were handed back.
    pub fn len(&self) -> usize {
        self.rows.len()
    }

    /// Whether no rows were handed back.
    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }

    /// Returns the first row, or None when the statement produced none.
    pub fn one(&self) -> Option<&Vec<Value>> {
        self.rows.first()
    }

    /// Returns the first column of the first row, or None when there is none.
    ///
    /// This is the shape of a COUNT or a MAX, where unwrapping one value out of
    /// two vectors is a cost the caller pays on every line.
    pub fn scalar(&self) -> Option<&Value> {
        self.rows.first().and_then(|row| row.first())
    }

    /// Returns the index of a column by name.
    ///
    /// @param name - the column name to look for
    pub fn column_index(&self, name: &str) -> Option<usize> {
        self.columns.iter().position(|held| held == name)
    }

    /// Returns one cell by row index and column name.
    ///
    /// @param row - the row index
    /// @param name - the column name
    pub fn get(&self, row: usize, name: &str) -> Option<&Value> {
        let column = self.column_index(name)?;
        self.rows.get(row)?.get(column)
    }
}

impl<'a> IntoIterator for &'a Rows {
    type Item = &'a Vec<Value>;
    type IntoIter = std::slice::Iter<'a, Vec<Value>>;

    fn into_iter(self) -> Self::IntoIter {
        self.rows.iter()
    }
}
