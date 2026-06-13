const Docker = require('dockerode');

const docker = new Docker({socketPath: '/var/run/docker.sock'});

const MB = 1024 * 1024;

async function provisionDatabase({ userId, dbName, dbPassword, hostPort }) {
    const container = await docker.createContainer({
        Image: 'postgres:15-alpine',
        name: `userdb_${userId}`,
        Volumes: {
            '/var/lib/postgresql/data': {}
        },
        Env: [
            `POSTGRES_DB=${dbName}`,
            `POSTGRES_USER=dbuser`,
            `POSTGRES_PASSWORD=${dbPassword}`,
            `POSTGRES_MAX_CONNECTIONS=10`,
            `POSTGRES_INITDB_ARGS=--data-checksums`
        ],
        Cmd: [
            'postgres',
            '-c', 'shared_buffers=32MB',
            '-c', 'max_connections=10',
            '-c', 'work_mem=4MB',
            '-c', 'maintenance_work_mem=16MB',
            `-c`, `max_wal_size=64MB`,
            `-c`, `min_wal_size=32MB`,
            '-c', 'temp_file_limit=128MB',
            '-c', 'statement_timeout=30000',
        ],
        HostConfig: {
            PortBindings: {'5432/tcp' : [{ HostPort: String(hostPort)}]},
            Memory: 128 * MB,
            MemorySwap: 128 * MB,
            NanoCpus: 5e8, // 0.5 CPU
            PidsLimit: 50,
            ShmSize: 32 * MB,
            ReadonlyRootfs: true,
            Tmpfs: { 
                '/tmp': 'rw,noexec,nosuid,size=32m',
                '/var/run/postgresql': 'rw,noexec,nosuid,size=4m'
             },
            Ulimits: [
                { Name: 'nofile', Soft: 128, Hard: 128},
                { Name: 'nproc', Soft: 50, Hard: 50},
            ],
            RestartPolicy: { Name: 'no' },
        }
    });

    await container.start();

    return container.id;
}

async function destroyDatabase(containerId) {
    try {
        const container = docker.getContainer(containerId);
        await container.stop().catch(() => {});
        await container.remove({ force: true, v: true });
    } catch (err) {
        console.error(`[Docker] Failed to destroy container ${containerId}: `, err.message);
    }
}

module.exports = { provisionDatabase, destroyDatabase };