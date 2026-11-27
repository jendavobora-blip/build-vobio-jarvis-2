"use client"

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"

interface RecognitionResultEvent {
  resultIndex: number
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>
}

interface RecognitionLike {
  lang: string
  interimResults: boolean
  continuous: boolean
  onresult: ((e: RecognitionResultEvent) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}

type RecognitionCtor = new () => RecognitionLike

function getRecognitionCtor(): RecognitionCtor | undefined {
  if (typeof window === "undefined") return undefined
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition
}

const noopSubscribe = () => () => {}

const ERRORS: Record<string, string> = {
  "not-allowed": "Přístup k mikrofonu byl zamítnut. Povolte ho v nastavení prohlížeče (Safari › Mikrofon).",
  "service-not-allowed": "Rozpoznávání řeči není v tomto prohlížeči povoleno. Použijte diktování na klávesnici iPhonu.",
  "no-speech": "Neslyšel jsem žádnou řeč. Zkuste to znovu.",
  "audio-capture": "Mikrofon nebyl nalezen.",
  network: "Rozpoznávání řeči vyžaduje připojení k internetu.",
  aborted: "",
}

export function useCzechVoice(onTranscript: (text: string, isFinal: boolean) => void) {
  const recognitionSupported = useSyncExternalStore(noopSubscribe, () => Boolean(getRecognitionCtor()), () => false)
  const synthesisSupported = useSyncExternalStore(
    noopSubscribe,
    () => typeof window !== "undefined" && "speechSynthesis" in window,
    () => false,
  )
  const [listening, setListening] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const recognitionRef = useRef<RecognitionLike | null>(null)
  const transcriptRef = useRef(onTranscript)
  transcriptRef.current = onTranscript

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop()
  }, [])

  const abortListening = useCallback(() => {
    const rec = recognitionRef.current
    if (!rec) return
    rec.onresult = null
    rec.onend = null
    rec.onerror = null
    rec.abort()
    recognitionRef.current = null
    setListening(false)
  }, [])

  const startListening = useCallback(() => {
    const Ctor = getRecognitionCtor()
    if (!Ctor) {
      setError("Hlasové rozpoznávání zde není podporováno. Klepněte do pole a použijte ikonu mikrofonu na klávesnici iPhonu.")
      return false
    }
    setError(null)
    window.speechSynthesis?.cancel()
    setSpeaking(false)
    const rec = new Ctor()
    rec.lang = "cs-CZ"
    rec.interimResults = true
    rec.continuous = false
    let finalText = ""
    rec.onresult = (e) => {
      let interim = ""
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]
        if (r.isFinal) finalText += r[0].transcript
        else interim += r[0].transcript
      }
      transcriptRef.current((finalText + interim).trim(), false)
    }
    rec.onerror = (e) => {
      const msg = ERRORS[e.error] ?? "Rozpoznávání řeči selhalo."
      if (msg) setError(msg)
    }
    rec.onend = () => {
      setListening(false)
      recognitionRef.current = null
      if (finalText.trim()) transcriptRef.current(finalText.trim(), true)
    }
    try {
      rec.start()
      recognitionRef.current = rec
      setListening(true)
      return true
    } catch {
      setError("Mikrofon se nepodařilo spustit.")
      return false
    }
  }, [])

  const speak = useCallback((text: string) => {
    if (!("speechSynthesis" in window)) return
    const clean = text.replace(/[#*`>_\-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 3000)
    if (!clean) return
    window.speechSynthesis.cancel()
    const utter = new SpeechSynthesisUtterance(clean)
    utter.lang = "cs-CZ"
    const voice = window.speechSynthesis.getVoices().find((v) => v.lang.toLowerCase().startsWith("cs"))
    if (voice) utter.voice = voice
    utter.onend = () => setSpeaking(false)
    utter.onerror = () => setSpeaking(false)
    setSpeaking(true)
    window.speechSynthesis.speak(utter)
  }, [])

  const stopSpeaking = useCallback(() => {
    window.speechSynthesis?.cancel()
    setSpeaking(false)
  }, [])

  useEffect(
    () => () => {
      recognitionRef.current?.abort()
      if (typeof window !== "undefined") window.speechSynthesis?.cancel()
    },
    [],
  )

  return {
    recognitionSupported,
    synthesisSupported,
    listening,
    speaking,
    error,
    clearError: () => setError(null),
    startListening,
    stopListening,
    abortListening,
    speak,
    stopSpeaking,
  }
}
