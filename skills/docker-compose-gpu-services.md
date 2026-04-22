# Docker Compose — GPU Services & Multi-Container Setup

## GPU Reservation Syntax

All GPU-dependent services use this block under `deploy`:

```yaml
deploy:
  resources:
    reservations:
      devices:
        - driver: nvidia
          count: 1
          capabilities: [gpu]
```

Requires `nvidia-container-toolkit` installed on the host and Docker daemon configured to use the nvidia runtime.

## Port Convention Used in This Project

| Service           | Host Port | Container Port |
|-------------------|-----------|----------------|
| styletts2-api     | 8100      | 8000           |
| seedvc-api        | 8101      | 8000           |
| make-an-audio-api | 8102      | 8000           |
| finetune-api      | 8103      | 8000           |
| jupyterlab        | 8104      | 8888           |
| frontend (Next.js)| 3001      | 3001           |
| inngest           | 8288      | 8288           |

## Named Volumes for Shared State

Services that need to share files (workspace, checkpoints) use a named volume:

```yaml
volumes:
  finetune_workspace:
    driver: local
```

Mount in services:
```yaml
volumes:
  - finetune_workspace:/workspace
```

## Frontend Dev Container Pattern

For a hot-reload dev container, mount the source as a volume and use an anonymous volume to preserve the container's `node_modules` (built for Linux, not the host OS):

```yaml
frontend:
  build:
    context: ./elevenlabs-clone-frontend
    dockerfile: Dockerfile
  volumes:
    - ./elevenlabs-clone-frontend:/app      # source mount (hot reload)
    - /app/node_modules                      # anonymous volume — keeps Linux node_modules
  environment:
    - HOSTNAME=0.0.0.0                       # bind to all interfaces
    - NODE_ENV=development
```

**Dockerfile for this pattern:**
```dockerfile
FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl

# Copy prisma BEFORE package.json — postinstall runs `prisma generate`
COPY prisma ./prisma
COPY package.json package-lock.json* ./
RUN npm install

EXPOSE 3001
ENV HOSTNAME=0.0.0.0
ENV NODE_ENV=development
CMD ["npm", "run", "dev"]
```

**Critical:** If `postinstall` runs `prisma generate`, the schema must be copied before `npm install`.

## Inter-Service Communication

Use Docker service names as hostnames. From `frontend`, reach `styletts2-api` at:
```
http://styletts2-api:8000
```

Override localhost-pointing env vars in the compose `environment` block:
```yaml
frontend:
  env_file:
    - ./elevenlabs-clone-frontend/.env     # contains localhost:8100 values
  environment:
    - STYLETTS2_API_ROUTE=http://styletts2-api:8000   # overrides .env value
    - SEED_VC_API_ROUTE=http://seedvc-api:8000
```

The `environment` block takes precedence over `env_file`.

## Inngest Dev Server

Points to the frontend container by service name:
```yaml
inngest:
  image: inngest/inngest
  command: inngest dev -u http://frontend:3001/api/inngest
```

## .dockerignore for Next.js

```
node_modules
.next
.env.local
.env.*.local
Dockerfile
.dockerignore
```

## Common Issues

### "prisma schema not found during npm install"
Prisma's postinstall hook runs `prisma generate` which needs `schema.prisma`. Copy `prisma/` before `package.json` in the Dockerfile.

### node_modules built for wrong platform
If host OS is Mac/Windows but container is Linux, native bindings won't work. The anonymous volume pattern (`- /app/node_modules`) ensures the container builds its own `node_modules` inside the container filesystem, separate from the host-mounted source.

### Service can't reach another service
- Use service names (`styletts2-api`), not `localhost`
- `localhost` inside a container refers to the container itself
- To reach the host machine from inside a container: use `host.docker.internal`
