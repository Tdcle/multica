"use client";

import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core/hooks";
import {
  knowledgeStateOptions,
  knowledgePanelOptions,
} from "@multica/core/knowledge";
import { useT } from "../i18n";

export function KnowledgePage() {
  const wsId = useWorkspaceId();
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
          src={panel.data.url}
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
