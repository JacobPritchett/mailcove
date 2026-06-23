import { useCallback, useState } from "react";

export type ReaderMode = "rich" | "chat";

const KEY = "reader.viewMode";

function read(): ReaderMode {
  try {
    return localStorage.getItem(KEY) === "chat" ? "chat" : "rich";
  } catch {
    return "rich";
  }
}

export function useReaderMode(): [ReaderMode, (m: ReaderMode) => void] {
  const [mode, setMode] = useState<ReaderMode>(read);
  const set = useCallback((m: ReaderMode) => {
    setMode(m);
    try {
      localStorage.setItem(KEY, m);
    } catch {
      /* storage unavailable */
    }
  }, []);
  return [mode, set];
}
