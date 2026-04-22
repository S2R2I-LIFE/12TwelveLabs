# Audio Web APIs — Recording, Encoding, Uploading

## Recording with MediaRecorder

```typescript
const startRecording = async () => {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mr = new MediaRecorder(stream);
  const chunks: Blob[] = [];

  mr.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  mr.onstop = async () => {
    stream.getTracks().forEach(t => t.stop());  // release microphone
    const blob = new Blob(chunks, { type: "audio/webm" });
    // Convert to WAV for backend compatibility
    const wavFile = await blobToWavFile(blob, `recording-${Date.now()}.wav`);
    setFile(wavFile);
  };

  mr.start();
};

const stopRecording = () => {
  mediaRecorderRef.current?.stop();
};
```

**Cleanup on unmount:**
```typescript
useEffect(() => {
  return () => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (mediaRecorderRef.current?.state === "recording")
      mediaRecorderRef.current.stop();
  };
}, []);
```

## WebM → WAV Conversion

Browser MediaRecorder produces WebM/Opus. StyleTTS2 and SeedVC need WAV. Use AudioContext to decode and re-encode:

```typescript
function audioBufferToWav(buf: AudioBuffer): Blob {
  const numCh = buf.numberOfChannels;
  const sr = buf.sampleRate;
  const len = buf.length;
  const ab = new ArrayBuffer(44 + len * numCh * 2);
  const v = new DataView(ab);

  const str = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };

  // RIFF header
  str(0, "RIFF");
  v.setUint32(4, 36 + len * numCh * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);     // PCM format chunk size
  v.setUint16(20, 1, true);      // PCM = 1
  v.setUint16(22, numCh, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * numCh * 2, true);  // byte rate
  v.setUint16(32, numCh * 2, true);       // block align
  v.setUint16(34, 16, true);              // bits per sample
  str(36, "data");
  v.setUint32(40, len * numCh * 2, true);

  // PCM samples (interleaved, 16-bit signed)
  let off = 44;
  for (let i = 0; i < len; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      const s = Math.max(-1, Math.min(1, buf.getChannelData(ch)[i]!));
      v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return new Blob([ab], { type: "audio/wav" });
}

async function blobToWavFile(blob: Blob, name: string): Promise<File> {
  const arrayBuf = await blob.arrayBuffer();
  const ctx = new AudioContext();
  const audioBuf = await ctx.decodeAudioData(arrayBuf);
  await ctx.close();
  return new File([audioBufferToWav(audioBuf)], name, { type: "audio/wav" });
}
```

## S3 Presigned URL Upload

Upload directly from the browser to S3 without going through the Next.js server:

```typescript
// Server action — generates presigned URL
export async function generateUploadUrl(contentType: string) {
  const key = `uploads/${nanoid()}.${contentType === "audio/wav" ? "wav" : "mp3"}`;
  const command = new PutObjectCommand({
    Bucket: env.S3_BUCKET_NAME,
    Key: key,
    ContentType: contentType,
  });
  const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 300 });
  return { uploadUrl, key };
}

// Client — PUT directly to S3
const { uploadUrl, key } = await generateUploadUrl(file.type);
await fetch(uploadUrl, {
  method: "PUT",
  body: file,
  headers: { "Content-Type": file.type },
});
// Pass `key` to the generation action
await generateSpeechToSpeech(key, selectedVoice.id);
```

## File Validation

```typescript
const ALLOWED_AUDIO_TYPES = ["audio/mp3", "audio/wav"];

const handleFileSelect = (file: File) => {
  const isAllowed = ALLOWED_AUDIO_TYPES.includes(file.type);
  const isUnder50MB = file.size <= 50 * 1024 * 1024;

  if (isAllowed && isUnder50MB) {
    setFile(file);
  } else {
    alert(isAllowed ? "File too large (max 50MB)" : "Only MP3 or WAV files");
  }
};
```

## Drag and Drop

```tsx
<div
  onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
  onDragLeave={() => setIsDragging(false)}
  onDrop={(e) => {
    e.preventDefault();
    setIsDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) handleFileSelect(f);
  }}
  onClick={() => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "audio/mp3,audio/wav";
    input.onchange = (e) => {
      const f = (e.target as HTMLInputElement).files?.[0];
      if (f) handleFileSelect(f);
    };
    input.click();
  }}
>
```

## Elapsed Recording Timer

```typescript
const [elapsed, setElapsed] = useState(0);
const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

// Start
timerRef.current = setInterval(() => setElapsed(s => s + 1), 1000);

// Stop
if (timerRef.current) clearInterval(timerRef.current);

// Display
const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
const ss = String(elapsed % 60).padStart(2, "0");
// renders as "01:23"
```
