"use client";

import { useEffect } from "react";
import { getVoiceModels } from "~/actions/voice-lab";
import { useVoiceStore } from "~/stores/voice-store";
import type { ServiceType } from "~/types/services";

export function VoiceStoreInitializer() {
  const setVoices = useVoiceStore((s) => s.setVoices);
  const selectVoice = useVoiceStore((s) => s.selectVoice);
  const getSelectedVoice = useVoiceStore((s) => s.getSelectedVoice);

  useEffect(() => {
    getVoiceModels()
      .then((voices) => {
        console.log("[VoiceStoreInitializer] loaded", voices.length, "voices:", voices.map(v => `${v.service}/${v.id}`));
        if (voices.length === 0) return;
        setVoices(voices);

        // Auto-select the first custom voice for any service that has no selection yet
        const services = [...new Set(voices.map((v) => v.service))] as ServiceType[];
        for (const svc of services) {
          if (!getSelectedVoice(svc)) {
            const first = voices.find((v) => v.service === svc);
            if (first) selectVoice(svc, first.id);
          }
        }
      })
      .catch((e) => console.error("[VoiceStoreInitializer] failed:", e));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // run once on mount

  return null;
}
