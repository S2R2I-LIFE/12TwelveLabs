import { create } from "zustand";
import { ServiceType } from "~/types/services";

const GRADIENT_COLORS = [
  "linear-gradient(45deg, #8b5cf6, #ec4899, #ffffff, #3b82f6)",
  "linear-gradient(45deg, #3b82f6, #10b981, #ffffff, #f59e0b)",
  "linear-gradient(45deg, #ec4899, #f97316, #ffffff, #8b5cf6)",
  "linear-gradient(45deg, #10b981, #3b82f6, #ffffff, #f43f5e)",
  "linear-gradient(45deg, #f43f5e, #f59e0b, #ffffff, #10b981)",
];

export interface Voice {
  id: string;
  name: string;
  gradientColors: string;
  service: ServiceType;
}

// Base voices for Seed-VC (voice changer) — reference audio is bundled in that container
const voices: Voice[] = [
  {
    id: "andreas",
    name: "Andreas",
    gradientColors: GRADIENT_COLORS[0]!,
    service: "seedvc",
  },
  {
    id: "woman",
    name: "Woman",
    gradientColors: GRADIENT_COLORS[1]!,
    service: "seedvc",
  },
  {
    id: "trump",
    name: "Trump",
    gradientColors: GRADIENT_COLORS[2]!,
    service: "seedvc",
  },
  // StyleTTS2 has no bundled reference audio — custom trained voices are loaded at runtime
];

const defaultStyleTTS2Voice: Voice | null = null; // populated by VoiceStoreInitializer
const defaultSeedVCVoice = voices.find((v) => v.service === "seedvc") ?? null;

interface VoiceState {
  voices: Voice[];
  isInitialized: boolean;
  selectedVoices: Record<ServiceType, Voice | null>;
  activeTTSVoice: Voice | null;
  getVoices: (service: ServiceType) => Voice[];
  getSelectedVoice: (service: ServiceType) => Voice | null;
  selectVoice: (service: ServiceType, voice: string) => void;
  setActiveTTSVoice: (voice: Voice | null) => void;
  setVoices: (incoming: Voice[]) => void;
  removeVoice: (service: ServiceType, voiceId: string) => void;
}

export const useVoiceStore = create<VoiceState>((set, get) => ({
  voices: voices,
  isInitialized: false,
  selectedVoices: {
    styletts2: defaultStyleTTS2Voice,
    seedvc: defaultSeedVCVoice,
    "make-an-audio": null,
    gptsovits: null,
  },
  activeTTSVoice: null,
  getVoices: (service) => {
    return get().voices.filter((voice) => voice.service === service);
  },
  getSelectedVoice: (service) => {
    return get().selectedVoices[service];
  },
  setActiveTTSVoice: (voice) => set({ activeTTSVoice: voice }),
  selectVoice: (service, voiceId) => {
    const serviceVoices = get().voices.filter(
      (voice) => voice.service === service,
    );

    const selectedVoice =
      serviceVoices.find((voice) => voice.id === voiceId) || serviceVoices[0];

    set((state) => ({
      selectedVoices: {
        ...state.selectedVoices,
        [service]: selectedVoice,
      },
    }));
  },
  setVoices: (incoming) => {
    set((state) => {
      // Merge by (service, id) — keep existing base voices, add/update custom ones
      const merged = [...state.voices];
      for (const v of incoming) {
        const idx = merged.findIndex(
          (existing) => existing.id === v.id && existing.service === v.service,
        );
        if (idx >= 0) {
          merged[idx] = v;
        } else {
          merged.push(v);
        }
      }
      // Auto-set activeTTSVoice to first TTS-capable voice if not already set
      const newActiveTTS =
        state.activeTTSVoice ??
        merged.find(
          (v) => v.service === "styletts2" || v.service === "gptsovits",
        ) ??
        null;
      return { voices: merged, isInitialized: true, activeTTSVoice: newActiveTTS };
    });
  },
  removeVoice: (service, voiceId) => {
    set((state) => {
      const voices = state.voices.filter(
        (v) => !(v.id === voiceId && v.service === service),
      );
      const current = state.selectedVoices[service];
      const currentTTS = state.activeTTSVoice;
      const newActiveTTS =
        currentTTS?.id === voiceId && currentTTS?.service === service
          ? (voices.find(
              (v) => v.service === "styletts2" || v.service === "gptsovits",
            ) ?? null)
          : currentTTS;
      return {
        voices,
        activeTTSVoice: newActiveTTS,
        selectedVoices: {
          ...state.selectedVoices,
          [service]:
            current?.id === voiceId
              ? (voices.find((v) => v.service === service) ?? null)
              : current,
        },
      };
    });
  },
}));
