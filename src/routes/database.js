const { nanoid } = require('nanoid');
const { provisionDatabase, destroyDatabase } = require('../services/docker');
const { getAvailablePort } = require('../services/portManager');
const db = require('../db/sqlite');

const TTL_HOURS = 24;

async function databasesRoutes(fastify) {
    fastify.post('/create', { preHandler: [fastify.authenticate]}, async (request, reply) =>{
        const userId = request.user.sub;

        const existing = db.prepare('SELECT * FROM databases WHERE user_id = ?').get(userId);
        if(existing) {
            const expiresIn = existing.expires_at - Math.floor(Date.now()/1000);
            return reply.code(409).send({
                error: 'You already have an active database',
                expires_in_seconds: Math.max(0, expiresIn)
            });
        }

        const port = getAvailablePort();

        if(!port) {
            return reply.code(503).send({ error: 'No available ports. Service at capacity.'});
        }

        const dbName = `db_${nanoid(8).toLowerCase()}`;
        const dbPassword = nanoid(20);
        const id = nanoid();
        const expiresAt = Math.floor(Date.now()/1000) + TTL_HOURS * 3600;

        const containerId = await provisionDatabase({userId, dbName, dbPassword, hostPort: port});

        db.prepare(`INSERT INTO databases (id, user_id, container_id, db_name, db_password, host_port, expires_at) VALUES (?,?,?,?,?,?,?)`)
            .run(id, userId, containerId, dbName, dbPassword, port, expiresAt);

        const host = process.env.PUBLIC_HOST || 'localhost';

        return reply.code(201).send({
            id,
            connection_string: `postgresql://dbuser:${dbPassword}@${host}:${port}/${dbName}`,
            host,
            port,
            db_name: dbName,
            username: 'dbuser',
            password: dbPassword,
            expires_at: expiresAt,
            expires_in_hours: TTL_HOURS
        });
    });

    fastify.get('/status', { preHandler: [fastify.authenticate]}, async (request, reply) => {
        const userId = request.user.sub;
        const record = db.prepare('SELECT * FROM databases WHERE user_id = ?').get(userId);

        if(!record) {
            return reply.code(404).send({ error: 'No active database found'});
        }

        const now = Math.floor(Date.now()/1000);
        const host = process.env.PUBLIC_HOST || 'localhost';

        return reply.send({
            id: record.id,
            connection_string: `postgresql://dbuser:${record.db_password}@${host}:${record.host_port}/${record.db_name}`,
            port: record.host_port,
            db_name: record.db_name,
            username: 'dbuser',
            expires_at: record.expires_at,
            expires_in_seconds: Math.max(0, record.expires_at - now),
            created_at: record.created_at
        });
    });

    fastify.delete('/delete', { preHandler: [fastify.authenticate]}, async (request, reply) => {
        const userId = request.user.sub;
        const record = db.prepare('SELECT * FROM databases WHERE user_id = ?').get(userId);

        if(!record) {
            return reply.code(404).send({ error: 'No active database found'});
        }

        await destroyDatabase(record.container_id);
        db.prepare('DELETE FROM databases WHERE id = ?').run(record.id);

        return reply.code(204).send();
    });
}

module.exports = databasesRoutes;