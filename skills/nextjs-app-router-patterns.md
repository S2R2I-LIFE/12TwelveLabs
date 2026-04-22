# Next.js App Router Patterns

## Project Structure

```
src/
  app/
    layout.tsx          ← root layout (server component)
    page.tsx            ← root page (redirects to /app/sign-in)
    app/
      layout.tsx        ← app layout (server component, wraps authenticated routes)
      sign-in/page.tsx  ← client component (useForm, signIn)
      sign-up/page.tsx  ← client component
      speech-synthesis/
        text-to-speech/page.tsx   ← server component (fetches historyItems)
        speech-to-speech/page.tsx
      sound-effects/
        generate/page.tsx
      voice-lab/
        train/page.tsx
        notebook/page.tsx
    api/
      voices/route.ts
      voice-lab/jobs/route.ts
      voice-lab/jobs/[jobId]/...
  components/
    client/             ← all client components ("use client")
    theme-provider.tsx
  actions/              ← server actions
  stores/               ← Zustand stores (client-side)
  lib/                  ← shared utilities
```

## Server vs Client Components

**Server components** (default): fetch data, no hooks, no event handlers.
**Client components**: `"use client"` directive, can use hooks, browser APIs.

```tsx
// Server component — fetch on server, pass to client
export default async function TextToSpeechPage() {
  const session = await auth();
  const historyItems = await db.audioHistory.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "desc" },
  });
  return <PageLayout historyItems={historyItems} ... />;
}

// Client component — interactivity
"use client";
export function TextToSpeechEditor({ service }: { service: ServiceType }) {
  const [text, setText] = useState("");
  ...
}
```

## Server Actions

Defined with `"use server"`, can be called from client components like regular async functions:

```typescript
// src/actions/voice-lab.ts
"use server";
import { db } from "~/server/db";
import { auth } from "~/server/auth";

export async function createTrainingJob(voiceName: string, language: string) {
  const session = await auth();
  if (!session?.user) throw new Error("Unauthorized");

  const job = await db.trainingJob.create({
    data: {
      userId: session.user.id,
      status: "uploading",
      ...
    },
  });
  return job;
}
```

**Call from client:**
```tsx
const job = await createTrainingJob(voiceName, language);
```

## API Routes (Route Handlers)

```typescript
// src/app/api/voices/route.ts
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const service = searchParams.get("service");
  // ...
  return NextResponse.json({ voices });
}

export async function POST(request: Request) {
  const body = await request.json();
  // ...
  return NextResponse.json({ success: true }, { status: 201 });
}
```

**Dynamic route:**
```typescript
// src/app/api/voice-lab/jobs/[jobId]/route.ts
export async function GET(
  request: Request,
  { params }: { params: { jobId: string } }
) {
  const { jobId } = params;
  // ...
}
```

## Redirects and Rewrites in `next.config.js`

```javascript
const config = {
  async redirects() {
    return [
      { source: "/", destination: "/app/sign-in", permanent: false },
    ];
  },
  async rewrites() {
    return [
      // Proxy JupyterLab — Next.js rewrites handle WebSocket proxying natively
      { source: "/jupyter/:path*", destination: `${process.env.JUPYTERLAB_URL}/jupyter/:path*` },
    ];
  },
  // allowedDevOrigins — only add if actually set, NEVER pass []
  ...(process.env.ALLOWED_DEV_ORIGINS
    ? { allowedDevOrigins: process.env.ALLOWED_DEV_ORIGINS.split(",").map(h => h.trim()) }
    : {}),
};
```

## Environment Variables

`src/env.js` (using `@t3-oss/env-nextjs`) validates env vars at build time:

```typescript
export const env = createEnv({
  server: {
    DATABASE_URL: z.string(),
    BACKEND_API_KEY: z.string(),
    FINETUNE_API_ROUTE: z.string(),
    JUPYTERLAB_URL: z.string(),
  },
  client: {
    // NEXT_PUBLIC_* only
  },
  runtimeEnv: {
    DATABASE_URL: process.env.DATABASE_URL,
    BACKEND_API_KEY: process.env.BACKEND_API_KEY,
    FINETUNE_API_ROUTE: process.env.FINETUNE_API_ROUTE,
    JUPYTERLAB_URL: process.env.JUPYTERLAB_URL,
  },
});
```

To skip validation (e.g. Docker build): `SKIP_ENV_VALIDATION=1 npm run build`

## NextAuth v5 (Auth.js)

```typescript
// src/server/auth.ts
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";

export const { auth, handlers, signIn, signOut } = NextAuth({
  providers: [
    Credentials({
      async authorize(credentials) {
        // verify email/password, return user or null
      }
    })
  ],
  callbacks: {
    session({ session, token }) {
      session.user.id = token.sub!;
      return session;
    }
  }
});
```

**Critical:** `AUTH_URL` env var must match the public-facing URL (e.g., `https://tts.s2r2i.com`), not `localhost`. This affects callback URLs for OAuth and credential redirects.

## Prisma with SQLite

```typescript
// src/server/db.ts
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };
export const db = globalForPrisma.prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
```

**Schema location:** `prisma/schema.prisma`  
**Push schema changes:** `npm run db:push` (uses `prisma db push`)  
**Generate client:** `npx prisma generate`

## Inngest (Background Jobs)

```typescript
// src/inngest/functions.ts
import { inngest } from "./client";

export const generateSpeech = inngest.createFunction(
  { id: "generate-speech" },
  { event: "speech/generate" },
  async ({ event, step }) => {
    const result = await step.run("call-api", async () => {
      // call styletts2-api
    });
    await step.run("save-to-db", async () => {
      // save audioUrl to db
    });
    return result;
  }
);
```

**Dev server URL:** `http://frontend:3001/api/inngest` (when running in Docker)  
**Event keys for local dev:** `INNGEST_EVENT_KEY=local`, `INNGEST_SIGNING_KEY=local`
