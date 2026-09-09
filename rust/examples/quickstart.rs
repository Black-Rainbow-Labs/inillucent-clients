//! A first program: create a table, write rows, read them back, and ask the
//! engine what it can do before composing anything unusual.
//!
//! Run it with `cargo run --example quickstart`.

use std::env::temp_dir;
use std::fs;

use inillucent::{supports, version, Database, Status, Support, Value};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = temp_dir().join(format!("inillucent-quickstart-{}.rdb", std::process::id()));
    let _ = fs::remove_file(&path);

    let database = Database::open(&path)?;
    let connection = database.connect()?;
    println!("{}", version()?);

    connection.run("CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT, rating REAL)")?;
    connection.execute(
        "INSERT INTO authors VALUES (?1, ?2, ?3)",
        &[Value::Integer(1), Value::from("Octavia Butler"), Value::Real(4.8)],
        None,
    )?;
    connection.execute(
        "INSERT INTO authors VALUES (?1, ?2, ?3)",
        &[Value::Integer(2), Value::from("Ursula Le Guin"), Value::Null],
        None,
    )?;

    let rows = connection.run("SELECT id, name, rating FROM authors ORDER BY id")?;
    for row in &rows {
        println!("{} {} {}", row[0], row[1], row[2]);
    }

    // The limit caps what is handed back; the total was counted, not estimated.
    let page = connection.execute("SELECT id, name FROM authors ORDER BY id", &[], Some(1))?;
    println!(
        "showing {} of {}{}",
        page.len(),
        page.total,
        if page.more { ", more to come" } else { "" }
    );

    // A transaction is a handle, so what a write did can be checked before commit.
    let mut transaction = connection.transaction()?;
    let changed = transaction.execute("INSERT INTO authors VALUES (3, 'Ted Chiang', 4.9)")?;
    if changed == 1 {
        transaction.commit()?;
    } else {
        transaction.rollback();
    }

    println!("authors: {}", connection.scalar("SELECT COUNT(*) FROM authors", &[])?.unwrap());
    println!("cancel supported: {}", supports("cancel")? == Support::Yes);

    match connection.cancel() {
        Err(why) if why.status == Status::Unsupported => {
            println!("cancel refused, and it named: {}", why.feature.unwrap_or_default());
        }
        other => other?,
    }

    drop(connection);
    database.close()?;
    let _ = fs::remove_file(&path);
    Ok(())
}
