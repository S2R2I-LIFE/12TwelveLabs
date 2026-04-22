# Prisma Schema Patterns

## Schema Location
`elevenlabs-clone-frontend/prisma/schema.prisma`

## Database File Paths

| Context | Path |
|---|---|
| Next.js frontend (host dev) | `file:./db.sqlite` (relative to `prisma/`) |
| Next.js frontend (Docker) | `file:./db.sqlite` (mounted volume at `/app/prisma/`) |
| finetune-api (Python) | `/prisma-data/db.sqlite` (volume mount) |

## Key Models

```prisma
model User {
  id            String       @id @default(cuid())
  email         String       @unique
  password      String
  credits       Int          @default(1000)
  createdAt     DateTime     @default(now())
  updatedAt     DateTime     @updatedAt
  audioHistory  AudioHistory[]
  voiceModels   VoiceModel[]
  trainingJobs  TrainingJob[]
}

model VoiceModel {
  id                 String       @id @default(cuid())
  userId             String
  name               String
  voiceId            String       @unique   // e.g. "voice-abc123", used in API calls
  service            String                 // "styletts2"
  checkpointPath     String?                // absolute path on shared volume
  referenceAudioPath String?
  gradientColors     String
  isActive           Boolean      @default(false)
  createdAt          DateTime     @default(now())
  updatedAt          DateTime     @updatedAt
  user               User         @relation(fields: [userId], references: [id], onDelete: Cascade)
  trainingJob        TrainingJob?
}

model TrainingJob {
  id             String     @id @default(cuid())
  userId         String
  voiceModelId   String     @unique
  status         String     // see status flow below
  currentStep    Int        @default(0)
  errorMessage   String?
  jobWorkDir     String?    // /workspace/jobs/<id>
  trainingEpochs Int        @default(75)
  batchSize      Int        @default(2)
  language       String     @default("en-us")
  createdAt      DateTime   @default(now())
  updatedAt      DateTime   @updatedAt
  user           User       @relation(fields: [userId], references: [id], onDelete: Cascade)
  voiceModel     VoiceModel @relation(fields: [voiceModelId], references: [id], onDelete: Cascade)
}
```

## TrainingJob Status Flow

```
uploading → preprocessing → transcribing → transcribing_done
  → segmenting → segmenting_done → curating
  → phonemizing → phonemizing_done
  → training → training_done
  → deploying → ready
  → failed (from any step)
```

## Commands

```bash
# Push schema changes to DB (dev — no migration files)
npm run db:push
# or:
npx prisma db push

# Generate Prisma client after schema change
npx prisma generate

# Open Prisma Studio (GUI)
npx prisma studio

# Reset DB (drops and re-creates)
npx prisma db push --force-reset
```

## Accessing Prisma from Python (finetune-api)

The Python backend accesses SQLite directly via `sqlite3` (no Prisma client). Column names are **camelCase** as defined in the schema:

```python
import sqlite3

conn = sqlite3.connect("/prisma-data/db.sqlite")
conn.row_factory = sqlite3.Row

row = conn.execute(
    "SELECT id, status, jobWorkDir, batchSize, trainingEpochs FROM TrainingJob WHERE id = ?",
    (job_id,)
).fetchone()

job_dir = row["jobWorkDir"]
batch_size = row["batchSize"]
```

## Postinstall Hook

`package.json` has:
```json
"scripts": {
  "postinstall": "prisma generate"
}
```

This means `npm install` automatically runs `prisma generate`. **The `prisma/` directory must be present before `npm install` runs** — critical for Docker builds. Always `COPY prisma ./prisma` before `COPY package.json` in the Dockerfile.

## onDelete: Cascade

All child models use `onDelete: Cascade` on their User relation. Deleting a user automatically deletes all their voice models, training jobs, and audio history. This is intentional — no orphaned records.

## Common Queries (TypeScript)

```typescript
// Get active job for a user (at most one)
const job = await db.trainingJob.findFirst({
  where: { userId, status: { not: "ready" } },
  include: { voiceModel: true },
  orderBy: { createdAt: "desc" },
});

// Get all active custom voices
const voices = await db.voiceModel.findMany({
  where: { userId, isActive: true },
});

// Update job status
await db.trainingJob.update({
  where: { id: jobId },
  data: { status: "training", updatedAt: new Date() },
});

// Create voice + job atomically
const result = await db.$transaction(async (tx) => {
  const voice = await tx.voiceModel.create({ data: { ... } });
  const job = await tx.trainingJob.create({ data: { voiceModelId: voice.id, ... } });
  return { voice, job };
});
```
