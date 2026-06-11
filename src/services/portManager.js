const db = require('../db/sqlite');

const PORT_MIN = 5433;
const PORT_MAX = 5532;

function getAvailablePort() {
    const usedPorts = new Set(db
        .prepare('SELECT host_port FROM databases')
        .all()
        .map((r) => r.host_port));

    for(let port = PORT_MIN; port <= PORT_MAX; port++) {
        if(!usedPorts.has(port)) return port;
    }

    return null;
}

module.exports = { getAvailablePort };