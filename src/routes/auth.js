const bcrypt = require('bcrypt');
const {nanoid} = require('nanoid');
const db = require('../db/sqlite');

async function authRoutes(fastify) {
    fastify.post('/register',{
        schema: {
            body: {
                type: 'object',
                required: ['email', 'password'],
                properties: {
                    email: { type: 'string', format: 'email'},
                    password: { type: 'string', minLength: 8 },
                }
            }
        }
    }, async (request, reply) => {
        const { email, password } = request.body;

        const existing = db.prepare('SELECT id from users WHERE email = ?').get(email);
        if(existing) {
            return reply.code(409).send({ error: 'Email already registered'});
        }

        const passwordHash = await bcrypt.hash(password, 12);
        const id = nanoid();

        db.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)').run(id, email, passwordHash);

        const token = fastify.jwt.sign({ sub: id, email});

        return reply.code(201).send({token});
    });

    fastify.post('/login', {
        schema: {
            body: {
                type: 'object',
                required: ['email', 'password'],
                properties: {
                    email: { type: 'string'},
                    password: { type: 'string'}
                }
            }
        }
    }, async (request, reply) => {
        const {email, password} = request.body;

        const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
        if(!user) {
            return reply.code(401).send({ error: 'Invalid credentials'});
        }

        const valid = await bcrypt.compare( password, user.password_hash);

        if(!valid) {
            return reply.code(401).send({ error: 'Invalid credentials'});
        }

        const token = fastify.jwt.sign({ sub: user.id, email: user.email});

        return reply.send({ token });
    });

    fastify.get('/me', { preHandler: [fastify.authenticate]}, async (request, reply) => {
        const user = db
            .prepare('SELECT id, email, created_at FROM users WHERE id = ?')
            .get(request.user.sub);

        if(!user) {
            return reply.code(404).send({ error: 'User not found'});
        }

        return reply.send(user);
    });
}

module.exports = authRoutes;
