const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '../../data');

if(!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR);
}

const db = new Database(path.join(DATA_DIR, 'metadata.db'));

const CREATE_USERS_AND_DATABASES_TABLE = `
    CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        create_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS databases (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        container_id TEXT NOT NULL,
        db_name TEXT NOT NULL,
        do_password TEXT NOT NULL,
        host_port INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER DEFAULT (unixepoch()),
        FOREIGN KEY (user_id) REFERENCES users(id)
    );
`;

db.exec(CREATE_USERS_AND_DATABASES_TABLE);

module.exports = db;