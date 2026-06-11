const cron = require('node-cron');
const { destroyDatabase } = require('./docker');
const db = require('../db/sqlite');

function startCleanupJob() {
    cron.schedule('*/30 * * * *', async () => {
        console.log('[CLEANUP] Running expired DB cleanup...');
        const now = Math.floor(Date.now()/1000);
        const expired = db.prepare('SELECT * FROM databases WHERE expires_at < ?').all(now);

        for(const record of expired) {
            const id = record.id;
            const containerId = record.container_id;
            const dbName = record.db_name;
            const userId = record.user_id;

            await destroyDatabase(containerId);
            db.prepare('DELETE FROM databases WHERE id = ?').run(id);

            console.log(`[CLEANUP] Removed expired DB: ${dbName} (user: ${userId})`)
        }

        if(expired.length === 0) {
            console.log('[CLEANUP] No expired DBs found.');
        }
    });

    console.log('[CLEANUP] Cleanup job scheduled (run every 30 minutes).');
}

module.exports = { startCleanupJob };