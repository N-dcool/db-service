const Docker = require('dockerode');

const docker = new Docker({socketPath: '/var/run/docker.sock'});

async function provisionDatabase({ userId, dbName, dbPassword, hostPort }) {
    const container = await docker.createContainer({
        Image: 'postgres:15-alpine',
        name: `userdb_${userId}`,
        Env: [
            `POSTGRES_DB=${dbName}`,
            `POSTGRES_USER=dbuser`,
            `POSTGRES_PASSWORD=${dbPassword}`,
            `POSTGRES_MAX_CONNECTIONS=10`
        ],
        HostConfig: {
            PortBindings: {'5432/tcp' : [{hostPort: String(hostPort)}]},
            Memory: 128 * 1024 * 1024,
            Ulimits: [{ Name: 'nofile', Soft: 64, Hard: 64}]
        }
    });

    await container.start();

    return container.id;
}

async function destroyDatabase(containerId) {
    try {
        const container = docker.getContainer(containerId);
        await container.stop().catch(() => {});
        await container.remove({ force: true});
    } catch (err) {
        console.error(`[Docker] Failed to destroy container ${containerId}: `, err.message);
    }
}

module.exports = { provisionDatabase, destroyDatabase };