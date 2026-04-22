# Zustand State Management

## Stores in This Project

| Store | File | Purpose |
|---|---|---|
| `useUIStore` | `src/stores/ui-store.ts` | Mobile drawer, dark mode, settings tab |
| `useVoiceStore` | `src/stores/voice-store.ts` | Voice list per service, selection |
| `useAudioStore` | `src/stores/audio-store.ts` | Playbar state, current audio |

## Basic Pattern

```typescript
import { create } from "zustand";

interface MyState {
  count: number;
  increment: () => void;
  reset: () => void;
}

export const useMyStore = create<MyState>((set) => ({
  count: 0,
  increment: () => set((state) => ({ count: state.count + 1 })),
  reset: () => set({ count: 0 }),
}));
```

## UI Store (full shape)

```typescript
interface UIState {
  isMobileDrawerOpen: boolean;
  isMobileMenuOpen: boolean;
  isMobileScreen: boolean;
  isDarkMode: boolean;
  activeTab: "settings" | "history";
  toggleMobileDrawer: () => void;
  toggleMobileMenu: () => void;
  setMobileScreen: (isMobile: boolean) => void;
  setActiveTab: (tab: "settings" | "history") => void;
  toggleDarkMode: () => void;
}
```

## Voice Store Pattern

Voices are keyed by service (`styletts2`, `seedvc`, `make-an-audio`). Each service has its own selected voice:

```typescript
interface VoiceStore {
  voices: Record<ServiceType, Voice[]>;
  selectedVoiceId: Record<ServiceType, string | null>;
  getVoices: (service: ServiceType) => Voice[];
  getSelectedVoice: (service: ServiceType) => Voice | null;
  selectVoice: (service: ServiceType, voiceId: string) => void;
  setVoices: (service: ServiceType, voices: Voice[]) => void;
  removeVoice: (service: ServiceType, voiceId: string) => void;
}
```

## Subscribing to Specific State (Avoid Re-renders)

Don't subscribe to the whole store — subscribe to only what you need:

```tsx
// ✓ Only re-renders when selectedVoice changes
const selectedVoice = useVoiceStore((state) => state.getSelectedVoice("styletts2"));

// ✓ Only re-renders when isDarkMode changes
const isDarkMode = useUIStore((s) => s.isDarkMode);

// ✗ Re-renders on ANY store change
const store = useVoiceStore();
```

## Initializing Dynamic State from Server

To seed the store with server-fetched data (custom voices from DB), use a client component that runs on mount:

```tsx
// src/components/client/voice-store-initializer.tsx
"use client";
import { useEffect } from "react";
import { useVoiceStore } from "~/stores/voice-store";
import { getVoiceModels } from "~/actions/voice-lab";

export function VoiceStoreInitializer() {
  const setVoices = useVoiceStore((s) => s.setVoices);

  useEffect(() => {
    getVoiceModels().then((voices) => {
      setVoices("styletts2", voices);
    });
  }, [setVoices]);

  return null;
}
```

Render this in a layout component that wraps all app pages.

## Reading State in Server Actions

You **cannot** access Zustand from server actions (they run on the server). Pass the needed values as function arguments from the client:

```typescript
// Server action
export async function generateSpeech(text: string, voiceId: string) {
  // voiceId comes from the client (Zustand), not fetched here
}

// Client component
const selectedVoice = useVoiceStore(s => s.getSelectedVoice("styletts2"));
await generateSpeech(text, selectedVoice.id);
```

## Zustand vs useState

Use **Zustand** for:
- State shared across multiple components (voice selection, dark mode, playbar)
- State that needs to persist across navigation without prop drilling

Use **useState** for:
- Local UI state contained within one component (loading, form values, hover state)
- State that doesn't need to be shared

## Common Pattern: Polling with Zustand

```typescript
const { playAudio } = useAudioStore();

useEffect(() => {
  if (!currentAudioId || !loading) return;

  const poll = setInterval(async () => {
    const status = await generationStatus(currentAudioId);
    if (status.success && status.audioUrl) {
      clearInterval(poll);
      setLoading(false);
      playAudio({ id: currentAudioId, audioUrl: status.audioUrl, ... });
    }
  }, 500);

  return () => clearInterval(poll);
}, [currentAudioId, loading, playAudio]);
```
