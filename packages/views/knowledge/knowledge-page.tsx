"use client";

import { useEffect, useRef } from "react";
import { useAuthStore } from "@multica/core/auth";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core/hooks";
import {
  knowledgeStateOptions,
  knowledgePanelOptions,
} from "@multica/core/knowledge";
import { useT } from "../i18n";
import { useNavigation } from "../navigation";

export function KnowledgePage() {
  const wsId = useWorkspaceId();
  const { searchParams } = useNavigation();
  const section = searchParams.get("section") === "skills" ? "skills" : "memory";
  const userId = useAuthStore((state) => state.user?.id);
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    if (!userId) return;
    const key = `multica:memory:onboarded:${userId}:${wsId}`;
    const receive = (event: MessageEvent) => {
      const source = frame.current?.contentWindow;
      if (
        !source || event.source !== source ||
        event.data?.type !== "multica-memory-onboarding"
      ) return;
      if (event.data.action === "read") {
        let completed = false;
        try {
          completed = window.localStorage.getItem(key) === "1";
        } catch {
          // Storage can be disabled; keep the console usable.
        }
        // Sandboxed frames have opaque origins; match the source before replying.
        source.postMessage({
          type: "multica-memory-onboarding-state", completed,
        }, "*");
      } else if (event.data.action === "write" && typeof event.data.completed === "boolean") {
        try {
          window.localStorage.setItem(key, event.data.completed ? "1" : "0");
        } catch {
          // A preference write must not interrupt the native console.
        }
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [userId, wsId]);
  useEffect(() => {
    const sendTheme = () => {
      frame.current?.contentWindow?.postMessage(
        {
          type: "multica-memory-appearance",
          dark: document.documentElement.classList.contains("dark"),
          language: document.documentElement.lang || "en",
        },
        "*",
      );
    };
    const receive = (event: MessageEvent) => {
      const source = frame.current?.contentWindow;
      if (!source || event.source !== source || event.data?.type !== "multica-memory-appearance-read") return;
      sendTheme();
    };
    const observer = new MutationObserver(sendTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "lang"],
    });
    window.addEventListener("message", receive);
    return () => {
      observer.disconnect();
      window.removeEventListener("message", receive);
    };
  }, []);
  const { t } = useT("knowledge");
  const state = useQuery({
    ...knowledgeStateOptions(wsId),
    refetchInterval: (query) =>
      query.state.data?.binding?.panelAvailable === true ? false : 5000,
  });
  const panel = useQuery({
    ...knowledgePanelOptions(wsId),
    enabled: state.data?.binding?.panelAvailable === true,
    // Renew the scoped session before its one-hour expiry.
    refetchInterval: 50 * 60_000,
    refetchOnWindowFocus: true,
    retry: false,
  });
  const loading =
    state.isPending ||
    (state.data?.binding?.panelAvailable === true && panel.isPending);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {panel.data?.url ? (
        <iframe
          key={panel.data.url}
          ref={frame}
          src={`${panel.data.url}&view=${section}`}
          title={t(($) => $.title)}
          className="min-h-0 w-full flex-1 border-0"
          referrerPolicy="no-referrer"
          sandbox="allow-scripts allow-forms allow-downloads allow-popups"
        />
      ) : (
        <p
          role={state.isError || panel.isError ? "alert" : "status"}
          className="p-6 text-body text-muted-foreground"
        >
          {loading
            ? t(($) => $.loading)
            : state.data?.configured === false
              ? t(($) => $.notConfigured)
              : t(($) => $.panelUnavailable)}
        </p>
      )}
    </div>
  );
}
