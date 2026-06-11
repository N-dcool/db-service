# DB-as-a-Service

A self-hosted PostgreSQL provisioning service running on a **Raspberry Pi 5**. Users register, get a JWT, and instantly receive an isolated PostgreSQL database with a connection string - valid for 24 hours, automatically destroyed on expiry.

Live at: `https://db.nareshchoudhary.com`  -  👷‍♂️ UI work pending 🚧

---
## Table of Contents

- [What It Does](#what-it-does)
- [Architecture](#architecture)
- [Traffic Flow](#traffic-flow)
- [Component Breakdown](#component-breakdown)
- [API Reference](#api-reference)
- [Project Structure](#project-structure)
- [Environment Variables](#environment-variables)
- [CI/CD Pipeline](#cicd-pipeline)
- [Local Development](#Local-development)
- [Deployment on Pi](#deployment-on-pi)
- [Security Model](#security-model)
- [Resource Budget](#resource-budget)
- [Roadmap](#roadmap)

---

## What It Does

```
User registers → gets JWT → calls POST /api/db/create
→ API spins up a postgres: 15-alpine container on the Pi → Returns a connection string with host, port, credentials
→ 24 hours later → cleanup job destroys the container automatically
```

**Key constraints per database:**
- 128 MB RAM hard limit
- 100 MB storage
- 24-hour TTL (auto-destroyed)
- No internet access from the DB container (`NetworkMode: none`)
- One active DB per user at a time

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                      INTERNET / USERS                        │
│                                                              │
│  Browser / curl / psql client                                │
└──────────────────────────────────────────────────────────────┘
                              │
                              │ HTTPS (db.nareshchoudhary.com)
                              ▼
┌──────────────────────────────────────────────────────────────┐
│                       CLOUDFLARE EDGE                        │
│                                                              │
│  • Terminates HTTPS / TLS (SSL certificate lives here)       │
│  • Zero Trust Tunnel – forwards traffic to Pi via outbound conn.
│  • Real home IP is NEVER exposed to internet                 │
└──────────────────────────────────────────────────────────────┘
                              │
                              │ HTTP (internal tunnel)
                              ▼
┌──────────────────────────────────────────────────────────────┐
│              RASPBERRY PI 5 (Ubuntu Server)                  │
│              16 GB RAM | 256 GB NVMe                         │
│                                                              │
│  ┌─────────────┐                                             │
│  │ cloudflared │   ← outbound tunnel daemon (receives from CF edge)
│  └─────────────┘                                             │
│         │                                                    │
│         │ HTTP → localhost:80                                │
│         ▼                                                    │
│  ┌─────────────┐                                             │
│  │   Traefik   │   ← reverse proxy (routes /api/* by Host header)
│  │  (port 80)  │                                             │
│  └─────────────┘                                             │
│         │                                                    │
│         │ HTTP → db-api:3001                                 │
│         ▼                                                    │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │              db-api (Node.js / Fastify)                 │ │
│  │                     port 3001                           │ │
│  │                                                         │ │
│  │  Routes:                                                │ │
│  │  ├── POST /api/auth/register                            │ │
│  │  ├── POST /api/auth/login                               │ │
│  │  ├── GET  /api/auth/me              (JWT required)      │ │
│  │  ├── POST /api/db/create            (JWT required)      │ │
│  │  ├── GET  /api/db/status            (JWT required)      │ │
│  │  ├── DELETE /api/db/delete          (JWT required)      │ │
│  │  └── GET  /api/health                                   │ │
│  │                                                         │ │
│  │  Services:                                              │ │
│  │  ├── docker.js       → Docker SDK (creates containers)  │ │
│  │  ├── portManager.js  → picks free port 5433-5532        │ │
│  │  └── cleanup.js      → cron every 30min, deletes expired│ │
│  │                                                         │ │
│  │  Data:                                                  │ │
│  │  └── SQLite (data/metadata.db)                          │ │
│  │      ├── users      table                               │ │
│  │      └── databases  table                               │ │
│  └─────────────────────────────────────────────────────────┘ │
│         │                                                    │
│         │ /var/run/docker.sock                               │
│         ▼                                                    │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │                    Docker Engine                        │ │
│  │                                                         │ │
│  │  userdb_<userId-1>  postgres:15-alpine  port 5433       │ │
│  │  userdb_<userId-2>  postgres:15-alpine  port 5434       │ │
│  │  userdb_<userId-N>  postgres:15-alpine  port 543N       │ │
│  │                                                         │ │
│  │  (max 100 containers, ports 5433-5532)                  │ │
│  │  (each: 128MB RAM, no network, 10 max connections)      │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌─────────────┐                                             │
│  │ Watchtower  │  ← polls Docker Hub every 5 min, auto-updates
│  └─────────────┘     db-api when new image is pushed         │
└──────────────────────────────────────────────────────────────┘
```
---

### API Request Flow

```
1. User → HTTPS → db.nareshchoudhary.com
   ↓
2. Cloudflare Edge  (SSL termination, DDoS protection)
   ↓ HTTP tunnel
3. cloudflared      (Pi daemon, outbound tunnel to Cloudflare)
   ↓ HTTP → localhost:80
4. Traefik          (matches Host header + /api prefix, routes to db-api)
   ↓ HTTP → db-api:3001
5. Fastify API      (validates JWT, runs business logic)
   ↓ Docker socket
6. Docker Engine    (creates/destroys postgres containers)
```


### Database Provisioning Flow

```
POST /api/db/create (with Bearer token)

  ├─ 1. Verify JWT → extract userId
  ├─ 2. Check: user already has DB? → 409
  ├─ 3. getAvailablePort() → scan 5433-5532 → pick free one
  │     └─ null? → 503 No ports available
  ├─ 4. Generate: dbName = "db_" + nanoid(8)
  │              dbPassword = nanoid(20)
  │              expiresAt = now + 24h
  ├─ 5. provisionDatabase() →
  │        docker.createContainer(postgres:15-alpine)
  │        Env: POSTGRES_DB, POSTGRES_USER=dbuser, POSTGRES_PASSWORD
  │        PortBindings: 5432/tcp → hostPort
  │        Memory: 128MB
  │        NetworkMode: none
  │        container.start()
  ├─ 6. INSERT into databases (SQLite)
  └─ 7. Return 201 { connection_string, host, port, expires_at, ... }
```

### Cleanup Flow (every 30 minutes)

```
node-cron fires '*/30 * * * *'
  │
  ├─ SELECT _ FROM databases WHERE expires_at < now
  ├─ For each expired record:
  │    ├─ container.stop()
  │    ├─ container.remove({ force: true })
  │    └─ DELETE FROM databases WHERE id = ?
  └─ Log: [CLEANUP] Removed expired DB: <dbName>
```

### CI/CD Flow

```
Developer pushes to GitHub main branch
  ↓
GitHub Actions workflow triggers
  ├─ Set up QEMU + Docker Buildx (ARM64 cross-compile)
  ├─ Login to Docker Hub
  └─ Build + push linux/arm64 image → ndcool/db-service:latest
       ↓
       ▼ (within 5 minutes)
Watchtower on Pi detects new image
  └─ Pulls new image → restarts db-api container
```

---

## Component Breakdown

### `src/index.js` – App Entry Point
Bootstraps Fastify, registers plugins (JWT, CORS), decorates `authenticate`, mounts route files, exposes health check, starts server and cleanup job.

### `src/db/sqlite.js` – Metadata Store
Opens (or creates) `data/metadata.db`. Defines two tables:

| Table | Purpose |
| --- | --- |
| `users` | id, email, password_hash, created_at |
| `databases` | id, user_id, container_id, db_name, db_password, host_port, expires_at, created_at |

### `src/middleware/auth.js` – JWT Guard
Single `preHandler` function – calls `request.jwtVerify()`. Returns 401 on failure. Applied to all protected routes.

### `src/services/docker.js` – Container Lifecycle
- **`provisionDatabase()`** – creates + starts a `postgres:15-alpine` container with memory cap, port binding, and no network access
- **`destroyDatabase()`** – stops + force-removes a container by ID

### `src/services/portManager.js` – Port Allocation
Queries the `databases` table, scans ports `5433-5532`, returns the first unused port. Returns `null` when all 100 are occupied.

### `src/services/cleanup.js` – Expiry Daemon
Schedules `cron('*/30 * * * *')`. On each tick: finds all expired database records, destroys each container, deletes the record from SQLite.

### `src/routes/auth.js` – Auth Endpoints
- `POST /api/auth/register` – bcrypt hash + nanoid ID + JWT sign → 201
- `POST /api/auth/login` – bcrypt compare + JWT sign → 200
- `GET /api/auth/me` – returns current user info (protected)

### `src/routes/database.js` – DB Management Endpoints
- `POST /api/db/create` – full provisioning flow → 201
- `GET /api/db/status` – returns active DB info + live TTL countdown
- `DELETE /api/db/delete` – manual early deletion → 204

---

## API Reference

| Method | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/api/health` | No | Service liveness check |
| `POST` | `/api/auth/register` | No | Register with email + password |
| `POST` | `/api/auth/login` | No | Login, returns JWT |
| `GET` | `/api/auth/me` | JWT | Current user info |
| `POST` | `/api/db/create` | JWT | Provision a new PostgreSQL DB |
| `GET` | `/api/db/status` | JWT | Active DB info + TTL |
| `DELETE` | `/api/db/delete` | JWT | Destroy your active DB |

**Authentication:** Pass JWT as `Authorization: Bearer <token>` header.

**Connection string format returned by `/api/db/create`:**

```
postgresql://dbuser:<password>@<PUBLIC_HOST>:<port>/<dbName>
```

---

## Project Structure


```
db-service/
├─ src/
│  ├─ db/
│  │  └─ sqlite.js          ← SQLite setup + schema
│  ├─ middleware/
│  │  └─ auth.js            ← JWT preHandler
│  ├─ services/
│  │  ├─ docker.js          ← provisionDatabase / destroyDatabase
│  │  ├─ portManager.js     ← port 5433-5532 allocation
│  │  └─ cleanup.js         ← 30-min cron for expired DBs
│  ├─ routes/
│  │  ├─ auth.js           ← /api/auth/_
│  │  └─ database.js        ← /api/db/_
│  └─ index.js              ← Fastify app entry point
├─ .github/
│  └─ workflows/
│     └─ deploy.yml         ← GitHub Actions CI/CD (ARM64 build)
├─ .env.example             ← Environment variable template
├─ .gitignore
├─ Dockerfile               ← Multi-stage ARM64 build
├─ docker-compose.yml       ← db-api + Watchtower services
└─ package.json

```

---

## Environment Variables

Copy `.env.example` to `.env` and fill in real values:

```env
JWT_SECRET=<random 32+ char string>
PUBLIC_HOST=db.yourdomain.com
ALLOWED_ORIGINS=https://yourdomain.com
PORT=3001
DOCKERHUB_USERNAME=yourdockerhubusername
```



Generate a secure JWT secret:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## CI/CD Pipeline

Every push to `main` automatically builds and publishes a new Docker image.

```
Push to main → GitHub Actions → Build ARM64 image → Push to Docker Hub
                                                     ↓
                                    Watchtower on Pi (polls every 5 min)
                                                     ↓
                                    Auto-pulls new image + restarts db-api
```


**GitHub Secrets required:**


| Secret | Value |
|---|---|
| `DOCKERHUB_USERNAME` | Your Docker Hub username |
| `DOCKERHUB_TOKEN` | Docker Hub access token (read/write) |


The workflow lives at `.github/workflows/deploy.yml`. It uses QEMU + Docker Buildx to cross-compile for `linux/arm64` (Pi 5 architecture) from any CI runner.

---

## Local Development

```bash
# Install dependencies
npm install

# Copy and edit env file
cp .env.example .env

# Start dev server (with --watch hot reload)
npm run dev

# Test health check
curl http://localhost:3001/api/health

# Register a user
curl -X POST http://localhost:3001/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"password123"}'

# Login
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"password123"}'
```


> *Note:* Auth routes work fully locally. `/api/db/*` routes require a running Docker socket – they will fail locally unless Docker Desktop is running and the socket is accessible.

**Test as container locally:**

```bash
docker build -t db-service:local .

docker run -d --name db-api-test \
  -p 3001:3001 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$(pwd)/data":/app/data \
  --env-file .env \
  db-service:local

docker logs db-api-test -f
```

---

## Deployment on Pi

### Prerequisites on Pi
```bash
# Create shared Docker network (once)
docker network create proxy

# Pull Postgres image (once)
docker pull postgres:15-alpine
```


### Traefik Setup (runs once, via Portainer or CLI)

Minimum required Traefik config when using **Cloudflare Tunnel**:

```yaml
command:
    - "--providers.docker=true"
    - "--providers.docker.exposedbydefault=false"
    - "--entrypoints.web.address=:80"
    - "--log.level=INFO"
```


> With Cloudflare Tunnel, Traefik only needs HTTP internally. Cloudflare handles HTTPS externally – do **not** configure TLS or Let's Encrypt on Traefik.

### Cloudflare Tunnel Setup

```bash
# Run cloudflared (using token from Cloudflare Zero Trust dashboard)
docker run -d \
  --name cloudflared \
  --network host \
  --restart unless-stopped \
  cloudflare/cloudflared:latest \
  tunnel --no-autoupdate run --token <your_token>
```


Configure public hostname in Cloudflare dashboard:
```
Subdomain: db  →  Domain: yourdomain.com
Type: HTTP     →  URL: localhost:80
```

### Deploy db-api + Watchtower
```bash
# SSH into Pi, create project folder
mkdir ~/db-service && cd ~/db-service

# Create .env with real values
nano .env

# Copy docker-compose.yml from repo (or scp it)
# Then start:
docker compose up -d

# Tail logs
docker logs db-api -f
```


### Verify Deployment
```bash
curl https://db.yourdomain.com/api/health
# Expected: {"status":"ok","timestamp":"..."}
```


---

## Security Model


| Control | Implementation |
|---|---|
| **Authentication** |	JWT (7-day expiry, HS256) |
| **Password storage** |	bcrypt (cost factor 12) |
| **DB isolation** |	Each container: `NetworkMode: none` (no internet) |
| **Memory cap** |	128 MB hard limit per container |
| **Connection cap** |	`POSTGRES_MAX_CONNECTIONS=10` |
| **File descriptor limit** |	`nofile` ulimit: 64 soft/hard |
| **Port isolation** |	Only 5433-5532 exposed; 5432 never forwarded |
| **IP exposure** |	Real home IP hidden behind Cloudflare Tunnel |
| **One DB per user** |	API enforces this at creation time |
| **Auto-expiry** |	24h TTL + cron cleanup every 30 minutes |



**Pi Firewall (UFW):**
```bash
sudo ufw allow 22               # SSH
sudo ufw allow 80               # HTTP (Traefik)
sudo ufw allow 443              # HTTPS (Traefik)
sudo ufw allow 5433:5532/tcp   # DB ports
sudo ufw enable
```

---

## Resource Budget

```
Pi 5 - 16 GB RAM:
├─ Ubuntu OS            ∼400 MB
├─ Portainer            ∼100 MB
├─ Traefik              ∼50 MB
├─ cloudflared          ∼20 MB
├─ db-api (Node.js)     ∼150 MB
├─ Prometheus+Grafana   ∼400 MB (Phase 5)
├─ SQLite metadata      ∼5 MB
├─ 80× DB containers    ∼10 GB  (80 × 128 MB)
└─ Buffer               ∼5 GB


Pi 5 - 256 GB NVMe:
└─ 80 users × 100 MB = 8 GB at full capacity
```

---

## Roadmap

| Phase | Status | Description |
| --- | --- | --- |
| 0 | ✅ | Cloudflare DDNS + port forwarding / tunnel setup |
| 1 | ✅ | Traefik reverse proxy + SSL on Pi |
| 2 | ✅ | Backend API: auth + provisioning + cleanup + CI/CD |
| 3 | ⏳ | Frontend UI (Next.js – register, dashboard, connection string) |
| 4 | ⏳ | Security hardening (rate limiting, input validation, SSH keys) |
| 5 | ⏳ | Monitoring (Prometheus + Grafana at `monitor.yourdomain.com`) |
| 6 | ⏳ | Portfolio write-up + public launch |

**Post-MVP ideas:**
- MySQL support (second engine option)
- Web-based SQL editor (browser query runner)
- DB export (`.sql` dump before expiry)
- Email reminder 2h before expiry
- Paid tier (longer TTL, more storage – Stripe)
- `npx clouddb create` CLI tool

---

## Tech Stack

| Layer | Technology |
| --- | --- |
| Runtime | Node.js 20 (Alpine) |
| Framework | Fastify 4 |
| Auth | @fastify/jwt + bcrypt |
| Metadata DB | better-sqlite3 (SQLite) |
| Container SDK | dockerode |
| Scheduler | node-cron |
| Reverse Proxy | Traefik v3 |
| Tunnel | Cloudflare Zero Trust Tunnel |
| Container Runtime | Docker Engine (on Pi) |
| CI/CD | GitHub Actions |
| Image Registry | Docker Hub |
| Auto-deploy | Watchtower |
| Hardware | Raspberry Pi 5 (16GB / 256GB NVMe) |

---

## Common Errors

| Error | Cause | Fix |
| --- | --- | --- |
| `Cannot find module 'better-sqlite3'` | Native build failed | Add `python3 make g++` to Dockerfile |
| `connect ENOENT /var/run/docker.sock` | Socket not mounted | Add socket volume in docker-compose |
| `EADDRINUSE port 3001` | Port already in use | `docker ps` – find and stop the conflicting container |
| `401 Unauthorized` | Missing or expired token | Re-login to get a fresh JWT |
| `503 No available ports` | All 100 ports occupied | Wait for cleanup job, or manually delete stale DBs |
| `EntryPoint doesn't exist: websecure` | Wrong Traefik label when using CF Tunnel | Change label to `entrypoints=web`, remove TLS lines |
| `client version 1.24 is too old` | Traefik v3.0.x on Docker 27.x+ | Use `traefik:v3` (floating tag), not `traefik:v3.0.4` |
| `Cannot negotiate ALPN: acme-tls/1` | TLS challenge fails behind Cloudflare | Remove Let's Encrypt from Traefik; CF handles SSL |
| DB container starts but can't connect | Pi firewall blocking ports | `sudo ufw allow 5433:5532/tcp` |