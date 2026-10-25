import { useEffect, useState } from "react";
import type { ThemePreference } from "./AppearanceSettings";

const THEME_STORAGE_KEY = "super-leader:theme";
function readPreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "dark" || stored === "system" ? stored : "light";
  } catch (error) {
    console.warn("无法读取外观偏好，使用浅色外观", error);
    return "light";
  }
}
export function useThemePreference() {
  const [preference, setPreferenceState] = useState<ThemePreference>(readPreference);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false);
  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media) return;
    const changed = () => setSystemDark(media.matches);
    media.addEventListener?.("change", changed);
    return () => media.removeEventListener?.("change", changed);
  }, []);
  function setPreference(value: ThemePreference) {
    setPreferenceState(value); setPersistenceError(null);
    try { window.localStorage.setItem(THEME_STORAGE_KEY, value); }
    catch (error) { setPersistenceError(error instanceof Error ? `外观已切换，但当前浏览器无法保存：${error.message}` : "外观已切换，但当前浏览器无法保存"); }
  }
  const theme = preference === "system" ? (systemDark ? "dark" : "light") : preference;
  return { preference, theme, setPreference, persistenceError };
}
