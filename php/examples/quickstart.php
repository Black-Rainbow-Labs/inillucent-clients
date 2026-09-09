<?php

declare(strict_types=1);

// A first program: create a table, write rows, read them back, and ask the
// engine what it can do before composing anything unusual.
//
// Run it with `php examples/quickstart.php`.

require __DIR__ . '/../autoload.php';

use Inillucent\Database;
use Inillucent\Driver;
use Inillucent\Support;
use Inillucent\UnsupportedFeatureException;

$directory = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'inillucent-quickstart-' . getmypid();
@mkdir($directory, 0777, true);
$path = $directory . DIRECTORY_SEPARATOR . 'library.rdb';

$database = Database::open($path);
$connection = $database->connect();

echo Driver::version(), PHP_EOL;

$connection->execute('CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT, rating REAL)');
$connection->execute('INSERT INTO authors VALUES (?1, ?2, ?3)', [1, 'Octavia Butler', 4.8]);
$connection->execute('INSERT INTO authors VALUES (?1, ?2, ?3)', [2, 'Ursula Le Guin', null]);

foreach ($connection->query('SELECT id, name, rating FROM authors ORDER BY id') as $author) {
    echo $author['id'], ' ', $author['name'], ' ', var_export($author['rating'], true), PHP_EOL;
}

// The limit caps what is handed back; the total was counted, not estimated.
$page = $connection->execute('SELECT id, name FROM authors ORDER BY id', [], 1);
echo 'showing ', count($page), ' of ', $page->total, $page->more ? ', more to come' : '', PHP_EOL;

// A transaction is a handle, so what a write did can be checked before commit.
$transaction = $connection->begin();
if ($transaction->execute("INSERT INTO authors VALUES (3, 'Ted Chiang', 4.9)") === 1) {
    $transaction->commit();
} else {
    $transaction->rollback();
}

echo 'authors: ', $connection->scalar('SELECT COUNT(*) FROM authors'), PHP_EOL;
echo 'cancel supported: ', Driver::supports('cancel') === Support::Yes ? 'true' : 'false', PHP_EOL;

try {
    $connection->cancel();
} catch (UnsupportedFeatureException $why) {
    echo 'cancel refused, and it named: ', $why->feature, PHP_EOL;
}

$connection->close();
$database->close();
foreach (glob($directory . DIRECTORY_SEPARATOR . '*') ?: [] as $file) {
    @unlink($file);
}
@rmdir($directory);
