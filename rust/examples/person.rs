//! Create a person table, insert rows, read them by column name, and update one.
//!
//! Run it with `cargo run --example person`.

use std::env::temp_dir;
use std::fs;

use inillucent::{Database, Value};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = temp_dir().join(format!("person-rs-{}.rdb", std::process::id()));
    let _ = fs::remove_file(&path);

    let database = Database::open(&path)?;
    let connection = database.connect()?;

    connection.run(
        "CREATE TABLE person (
           id         INTEGER PRIMARY KEY,
           first_name TEXT NOT NULL,
           last_name  TEXT NOT NULL,
           email      TEXT,
           age        INTEGER,
           height_m   REAL
         )",
    )?;

    // Insert. Values go in as ?1, ?2 and so on, never pasted into the text.
    let mut insert = connection.prepare(
        "INSERT INTO person (first_name, last_name, email, age, height_m) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
    )?;
    insert.execute(
        &[
            Value::from("Ada"),
            Value::from("Lovelace"),
            Value::from("ada@example.com"),
            Value::Integer(36),
            Value::Real(1.65),
        ],
        None,
    )?;
    insert.execute(
        &[
            Value::from("Grace"),
            Value::from("Hopper"),
            Value::Null,
            Value::Integer(85),
            Value::Real(1.57),
        ],
        None,
    )?;
    drop(insert);

    // Read. `get` takes the column name, so the order of the SELECT does not
    // have to be carried in your head.
    let rows = connection.run(
        "SELECT id, first_name, last_name, email, age, height_m FROM person ORDER BY id",
    )?;
    for nth in 0..rows.len() {
        println!(
            "{} {} {} {} {} {}",
            rows.get(nth, "id").unwrap(),
            rows.get(nth, "first_name").unwrap(),
            rows.get(nth, "last_name").unwrap(),
            rows.get(nth, "email").unwrap(),
            rows.get(nth, "age").unwrap(),
            rows.get(nth, "height_m").unwrap(),
        );
    }

    // One value.
    println!("people: {}", connection.scalar("SELECT COUNT(*) FROM person", &[])?.unwrap());

    // Update, and read the row back.
    let changed = connection.execute(
        "UPDATE person SET email = ?1 WHERE last_name = ?2",
        &[Value::from("grace@example.com"), Value::from("Hopper")],
        None,
    )?;
    println!("updated: {}", changed.affected.unwrap_or(0));
    println!(
        "email now: {}",
        connection
            .scalar("SELECT email FROM person WHERE last_name = ?1", &[Value::from("Hopper")])?
            .unwrap()
    );

    drop(connection);
    database.close()?;
    let _ = fs::remove_file(&path);
    Ok(())
}
