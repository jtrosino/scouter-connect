
const sqlite3 = require('sqlite3').verbose();

// Connect to the persistent database on Render
const db = new sqlite3.Database('/var/data/users.db', (err) => {
  if (err) {
    console.error('Error connecting to database:', err.message);
  } else {
    console.log('Connected to /var/data/users.db');
  }
});

// Query the number of rows in the creators table and display some records
db.serialize(() => {
  db.get('SELECT COUNT(*) AS count FROM creators', (err, row) => {
    if (err) {
      console.error('Error counting creators:', err.message);
    } else {
      console.log(`Total creators in DB: ${row.count}`);
    }
  });

  db.all('SELECT * FROM creators ORDER BY created_at DESC LIMIT 5', (err, rows) => {
    if (err) {
      console.error('Error fetching creators:', err.message);
    } else {
      console.log('Most recent 5 creators:');
      console.table(rows);
    }
  });
});

db.close();
