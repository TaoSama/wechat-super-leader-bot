import { useCallback, useEffect, useRef, useState } from "react";

export const MOBILE_SESSION_QUERY = "(max-width: 719px)";
const HISTORY_NAMESPACE = "superLeaderSessionWorkspace";
interface NavigationEntry { owner: string; sessionKey: string }

function entry(): NavigationEntry | undefined {
  return window.history.state?.[HISTORY_NAMESPACE] as NavigationEntry | undefined;
}

/** Keep the selected session and its hook state while navigating back to the list. */
export function useSessionNavigation() {
  const owner = useRef(crypto.randomUUID());
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [detailVisible, setDetailVisible] = useState(false);
  const [mobile, setMobile] = useState(() => window.matchMedia?.(MOBILE_SESSION_QUERY).matches ?? false);

  useEffect(() => {
    const media = window.matchMedia?.(MOBILE_SESSION_QUERY);
    const change = () => setMobile(media?.matches ?? false);
    media?.addEventListener("change", change);
    return () => media?.removeEventListener("change", change);
  }, []);

  useEffect(() => {
    const navigate = () => {
      const current = entry();
      if (current?.owner === owner.current) {
        setSelectedKey(current.sessionKey);
        setDetailVisible(true);
      } else {
        setDetailVisible(false);
      }
    };
    window.addEventListener("popstate", navigate);
    return () => {
      window.removeEventListener("popstate", navigate);
      if (entry()?.owner === owner.current) {
        const state = { ...window.history.state };
        delete state[HISTORY_NAMESPACE];
        window.history.replaceState(state, "");
      }
    };
  }, []);

  const openSession = useCallback((key: string) => {
    if (window.matchMedia?.(MOBILE_SESSION_QUERY).matches) {
      const state = { ...window.history.state, [HISTORY_NAMESPACE]: { owner: owner.current, sessionKey: key } };
      if (entry()?.owner === owner.current) window.history.replaceState(state, "");
      else window.history.pushState(state, "");
    }
    setSelectedKey(key);
    setDetailVisible(true);
  }, []);

  const backToList = useCallback(() => {
    setDetailVisible(false);
    if (entry()?.owner === owner.current) window.history.back();
  }, []);

  return { selectedKey, detailVisible, mobile, openSession, backToList };
}
