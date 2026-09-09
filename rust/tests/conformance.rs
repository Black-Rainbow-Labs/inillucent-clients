//! Runs conformance/suite.json against this client.
//!
//! The suite is the driver's behaviour written as data rather than as prose, and
//! every client library in this repository runs the same file. When two of them
//! disagree, one of them is wrong; when they agree, the specification is one that
//! can actually be followed.

use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use inillucent::{Database, Error, Rows, Status, Value};
use serde_json::Value as Json;

/// Returns the path of the shared conformance suite.
fn suite_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("conformance").join("suite.json")
}

/// Reads a value out of the suite's one key object form.
///
/// One key rather than a bare literal, so that NULL and the empty string can
/// never be confused by the file itself.
///
/// @param described - a value object such as `{"int": 7}`
fn value_of(described: &Json) -> Value {
    if described.get("null").is_some() {
        return Value::Null;
    }
    if let Some(whole) = described.get("int") {
        return Value::Integer(whole.as_i64().expect("int must be an integer"));
    }
    if let Some(number) = described.get("real") {
        return Value::Real(number.as_f64().expect("real must be a number"));
    }
    if let Some(text) = described.get("text") {
        return Value::Text(text.as_str().expect("text must be a string").to_owned());
    }
    if let Some(bytes) = described.get("blob") {
        let listed = bytes.as_array().expect("blob must be an array");
        return Value::Blob(listed.iter().map(|byte| byte.as_u64().unwrap_or(0) as u8).collect());
    }
    panic!("{described} names no value kind");
}

/// Returns a database path nothing else is using.
///
/// @param name - the case name, so a leftover file says which case left it
fn scratch_path(name: &str) -> PathBuf {
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    std::env::temp_dir().join(format!("inillucent-conformance-rs-{name}-{stamp}.rdb"))
}

/// Checks the rows a successful step handed back.
///
/// @param step - the case step, which asserts only the keys it carries
/// @param rows - what the client returned
/// @param wrong - collects one line per disagreement
fn check_rows(step: &Json, rows: &Rows, wrong: &mut Vec<String>) {
    let want = step["rows"].as_array().expect("rows must be an array");
    if want.len() != rows.rows.len() {
        wrong.push(format!(
            "there are {} rows and there should be {}",
            rows.rows.len(),
            want.len()
        ));
        return;
    }
    for (nth, row) in want.iter().enumerate() {
        let cells = row.as_array().expect("a row must be an array");
        let got = &rows.rows[nth];
        if cells.len() != got.len() {
            wrong.push(format!(
                "row {nth} has {} cells and should have {}",
                got.len(),
                cells.len()
            ));
            continue;
        }
        for (column, cell) in cells.iter().enumerate() {
            let expected = value_of(cell);
            if expected != got[column] {
                wrong.push(format!(
                    "row {nth} column {column} is {:?} and should be {expected:?}",
                    got[column]
                ));
            }
        }
    }
}

/// Checks a step that was expected to succeed.
fn check_success(step: &Json, rows: &Rows, wrong: &mut Vec<String>) {
    if let Some(status) = step.get("status") {
        wrong.push(format!("expected it to fail with `{status}` and it succeeded"));
        return;
    }
    if let Some(columns) = step.get("columns") {
        let want: Vec<String> = columns
            .as_array()
            .expect("columns must be an array")
            .iter()
            .map(|name| name.as_str().unwrap_or_default().to_owned())
            .collect();
        if want != rows.columns {
            wrong.push(format!("columns are {:?} and should be {want:?}", rows.columns));
        }
    }
    if step.get("rows").is_some() {
        check_rows(step, rows, wrong);
    }
    if let Some(affected) = step.get("affected") {
        let want = if affected.is_null() { None } else { affected.as_i64() };
        if rows.affected != want {
            wrong.push(format!("affected is {:?} and should be {want:?}", rows.affected));
        }
    }
    if let Some(total) = step.get("total") {
        let want = total.as_u64().unwrap_or_default() as usize;
        if rows.total != want {
            wrong.push(format!(
                "total is {} and should be {want}, and total is exact, so this is a real \
                 disagreement rather than an estimate being off",
                rows.total
            ));
        }
    }
    if let Some(more) = step.get("more") {
        if rows.more != more.as_bool().unwrap_or(false) {
            wrong.push(format!("more is {} and should be {more}", rows.more));
        }
    }
}

/// Checks a step that was expected to fail.
fn check_failure(step: &Json, failure: &Error, wrong: &mut Vec<String>) {
    let Some(status) = step.get("status").and_then(Json::as_str) else {
        wrong.push(format!("it was expected to succeed and it failed: {failure}"));
        return;
    };
    if failure.status.name() != status {
        wrong.push(format!(
            "it failed with `{}` and should have failed with `{status}`, saying: {failure}",
            failure.status.name()
        ));
    }
    if let Some(holds) = step.get("message_contains").and_then(Json::as_str) {
        if !failure.message.contains(holds) {
            wrong.push(format!("the message is {:?} and should hold {holds:?}", failure.message));
        }
    }
    if let Some(holds) = step.get("feature_contains").and_then(Json::as_str) {
        match failure.feature.as_deref() {
            None => wrong.push(
                "it named no construct, and an unsupported refusal has to name one or an \
                 application cannot say what it hit"
                    .to_owned(),
            ),
            Some(named) if !named.contains(holds) => wrong.push(format!(
                "it named {named:?} and should have named something holding {holds:?}"
            )),
            Some(_) => {}
        }
    }
    if failure.status == Status::Unsupported {
        if !failure.is_unsupported() {
            wrong.push("an unsupported refusal did not report itself as one".to_owned());
        }
        if failure.feature.is_none() {
            wrong.push("an unsupported refusal must carry a feature".to_owned());
        }
    }
}

/// Runs one case and returns one line per disagreement.
fn run_case(case: &Json) -> Vec<String> {
    let name = case["name"].as_str().unwrap_or("unnamed");
    let path = scratch_path(name);
    let mut wrong = Vec::new();

    {
        let database = Database::open(&path).expect("the scratch database must open");
        let connection = database.connect().expect("a connection must open");

        if let Some(setup) = case.get("setup").and_then(Json::as_array) {
            for statement in setup {
                let sql = statement.as_str().unwrap_or_default();
                if let Err(why) = connection.run(sql) {
                    wrong.push(format!("the setup statement `{sql}` was refused: {why}"));
                }
            }
        }

        if wrong.is_empty() {
            if let Some(steps) = case.get("steps").and_then(Json::as_array) {
                for step in steps {
                    let sql = step["sql"].as_str().unwrap_or_default();
                    let params: Vec<Value> = step
                        .get("params")
                        .and_then(Json::as_array)
                        .map(|listed| listed.iter().map(value_of).collect())
                        .unwrap_or_default();
                    let limit = step.get("limit").and_then(Json::as_u64);
                    let mut said = Vec::new();
                    match connection.execute(sql, &params, limit) {
                        Ok(rows) => check_success(step, &rows, &mut said),
                        Err(failure) => check_failure(step, &failure, &mut said),
                    }
                    for problem in said {
                        wrong.push(format!("`{sql}`: {problem}"));
                    }
                }
            }
        }
    }

    let _ = fs::remove_file(&path);
    wrong
}

#[test]
fn the_conformance_suite_passes() {
    let path = suite_path();
    let text = fs::read_to_string(&path)
        .unwrap_or_else(|why| panic!("cannot read {}: {why}", path.display()));
    let suite: Json = serde_json::from_str(&text).expect("the suite must be valid JSON");

    let mut failures = Vec::new();
    let cases = suite["cases"].as_array().expect("the suite must have cases");
    for case in cases {
        let name = case["name"].as_str().unwrap_or("unnamed");
        let wrong = run_case(case);
        println!("  {}  {name}", if wrong.is_empty() { "ok  " } else { "FAIL" });
        for problem in &wrong {
            println!("          {problem}");
            failures.push(format!("{name}: {problem}"));
        }
    }

    assert!(
        failures.is_empty(),
        "{} of {} conformance cases disagreed:\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n")
    );
}

#[test]
fn the_capability_table_can_be_read() {
    // Reading it here also proves the C strings it hands back survive being
    // copied out, which is the rule a binding is most likely to get wrong.
    let rows = inillucent::capabilities().expect("the capability table must be readable");
    assert!(!rows.is_empty(), "the engine declares no capabilities at all");

    assert_eq!(
        inillucent::supports("cancel").unwrap(),
        inillucent::Support::No,
        "cancel is declared unsupported, and a client that reported otherwise would have an \
         application drawing a Stop button that cannot work"
    );
    assert_eq!(
        inillucent::supports("time_travel").unwrap(),
        inillucent::Support::Unknown,
        "a capability nobody declared must answer Unknown rather than No: they mean different \
         things, and one of them is a checked absence"
    );
}
