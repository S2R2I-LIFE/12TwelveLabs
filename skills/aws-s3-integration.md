# AWS S3 Integration

## Project S3 Setup

- **Bucket:** `b-gpt-elevenlabs-clone`
- **Region:** `us-east-1`
- **Prefixes by service:**
  - `styletts2-output/` — TTS audio output
  - `seedvc-outputs/` — voice changer output
  - `make-an-audio-outputs/` — sound effects output
  - `uploads/` — user-uploaded audio (for voice changer input)

## Environment Variables

```
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=us-east-1
S3_BUCKET_NAME=b-gpt-elevenlabs-clone
```

## S3 Client Setup (Next.js / TypeScript)

```typescript
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3Client = new S3Client({
  region: env.AWS_REGION,
  credentials: {
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
  },
});
```

## Presigned Upload URL (client → S3 direct)

```typescript
export async function generateUploadUrl(contentType: string) {
  const ext = contentType === "audio/wav" ? "wav" : "mp3";
  const key = `uploads/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

  const command = new PutObjectCommand({
    Bucket: env.S3_BUCKET_NAME,
    Key: key,
    ContentType: contentType,
  });

  const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 300 });
  return { uploadUrl, key };
}
```

## Presigned Download URL (for playback)

```typescript
export async function getAudioUrl(key: string) {
  const command = new GetObjectCommand({
    Bucket: env.S3_BUCKET_NAME,
    Key: key,
  });
  return getSignedUrl(s3Client, command, { expiresIn: 3600 });
}
```

## S3 Upload from Python Backend

```python
import boto3

s3 = boto3.client(
    "s3",
    region_name=os.environ["AWS_REGION"],
    aws_access_key_id=os.environ["AWS_ACCESS_KEY_ID"],
    aws_secret_access_key=os.environ["AWS_SECRET_ACCESS_KEY"],
)

def upload_file(local_path: str, s3_key: str) -> str:
    bucket = os.environ["S3_BUCKET"]
    s3.upload_file(local_path, bucket, s3_key)
    # Return a presigned URL valid for 1 hour
    return s3.generate_presigned_url(
        "get_object",
        Params={"Bucket": bucket, "Key": s3_key},
        ExpiresIn=3600,
    )
```

## S3 Bucket CORS (for direct browser uploads)

The bucket needs CORS configured to allow `PUT` from the browser:

```json
[
  {
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["PUT", "GET"],
    "AllowedOrigins": ["https://tts.s2r2i.com", "http://localhost:3001"],
    "ExposeHeaders": []
  }
]
```

Configure via AWS Console → S3 → Bucket → Permissions → CORS.

## Flow: Voice Changer Upload

```
Browser                Next.js               S3
  │                       │                   │
  │─ POST /api/upload ────▶                   │
  │◀─ { uploadUrl, key } ─│                   │
  │                       │                   │
  │─── PUT uploadUrl ─────────────────────────▶
  │◀── 200 OK ────────────────────────────────│
  │                       │                   │
  │─ POST /api/generate ──▶                   │
  │  { key, voiceId }     │─ triggers Inngest │
  │                       │  job with s3 key  │
```
