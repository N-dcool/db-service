require('dotenv').config();
const Fastify = require('fastify');
const authMiddleware = require('./middleware/auth');
const { startCleanupJob } = require('./services/cleanup');

const app = Fastify({ logger: true});

app.register(require('@fastify/jwt'), {
    secret: process.env.JWT_SECRET || 'temp_jwt_secret_change_it',
    sign: { expiresIn: '7d'}
});

app.register(require('@fastify/cors'), {
    origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*'
});

app.decorate('authenticate', authMiddleware);

app.register(require('./routes/auth'), { prefix: '/api/auth'});
app.register(require('./routes/database'), { prefix: '/api/db'});

app.get('/api/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString()
}));

const start = async () => {
    try {
        const port = Number(process.env.PORT) || 3001;
        await app.listen({ port, host: '0.0.0.0'});
        startCleanupJob();
        console.log(`[SERVER] Running on port ${port}`);

    } catch(err) {
        app.log.error(err);
        process.exit(1);
    }
};

start();