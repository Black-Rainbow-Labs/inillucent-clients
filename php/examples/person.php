<?php

declare(strict_types=1);

// Create a person table, insert rows, read them by column name, and update one.
//
// Run it with `php examples/person.php`.

require __DIR__ . '/../autoload.php';

use Inillucent\Database;

$directory = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'person-php-' . getmypid();
@mkdir($directory, 0777, true);
$path = $directory . DIRECTORY_SEPARATOR . 'person.rdb';

$database = Database::open($path);
$connection = $database->connect();

$connection->execute('CREATE TABLE person (
      id         INTEGER PRIMARY KEY,
      first_name TEXT NOT NULL,
      last_name  TEXT NOT NULL,
      email      TEXT,
      age        INTEGER,
      height_m   REAL
    )');

// Insert. Values go in as ?1, ?2 and so on, never pasted into the text.
$insert = 'INSERT INTO person (first_name, last_name, email, age, height_m)'
    . ' VALUES (?1, ?2, ?3, ?4, ?5)';
$connection->execute($insert, ['Ada', 'Lovelace', 'ada@example.com', 36, 1.65]);
$connection->execute($insert, ['Grace', 'Hopper', null, 85, 1.57]);

// Read. query() gives an array per row, keyed by column name.
$people = $connection->query(
    'SELECT id, first_name, last_name, email, age, height_m FROM person ORDER BY id'
);
foreach ($people as $person) {
    echo $person['id'], ' ', $person['first_name'], ' ', $person['last_name'], ' ',
        $person['email'] ?? 'NULL', ' ', $person['age'], ' ', $person['height_m'], PHP_EOL;
}

// One value.
echo 'people: ', $connection->scalar('SELECT COUNT(*) FROM person'), PHP_EOL;

// Update, and read the row back.
$changed = $connection->execute(
    'UPDATE person SET email = ?1 WHERE last_name = ?2',
    ['grace@example.com', 'Hopper']
);
echo 'updated: ', $changed->affected, PHP_EOL;
echo 'email now: ', $connection->scalar(
    'SELECT email FROM person WHERE last_name = ?1',
    ['Hopper']
), PHP_EOL;

$connection->close();
$database->close();
foreach (glob($directory . DIRECTORY_SEPARATOR . '*') ?: [] as $file) {
    @unlink($file);
}
@rmdir($directory);
