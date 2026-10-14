"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BookOpenText, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import {
  knowledgeStateOptions,
  knowledgeExtractionsOptions,
  knowledgePanelOptions,
  useRetryKnowledgeExtraction,
} from "@multica/core/knowledge";
import { Button } from "@multica/ui/components/ui/button";
import { Badge } from "@multica/ui/components/ui/badge";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@multica/ui/components/ui/tabs";
import { CollectionPageHeader } from "../layout/collection-page";
import { AppLink } from "../navigation";
import { useT } from "../i18n";
import { MemoryManager } from "./memory-manager";

export function KnowledgePage() {
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const { t } = useT("knowledge");
  const [tab, setTab] = useState("memories");
  const state = useQuery({
    ...knowledgeStateOptions(wsId),
    refetchInterval: 5000,
  });
  const history = useQuery(knowledgeExtractionsOptions(wsId));
  const panel = useQuery({
    ...knowledgePanelOptions(wsId),
    enabled: state.data?.binding?.panelAvailable === true && tab === "panel",
    retry: false,
  });
  const retry = useRetryKnowledgeExtraction(wsId);
  const statusLabel = (status: string) => {
    switch (status) {
      case "pending":
        return t(($) => $.pending);
      case "processing":
        return t(($) => $.processing);
      case "submitted":
        return t(($) => $.submitted);
      case "ready":
        return t(($) => $.ready);
      case "failed":
        return t(($) => $.failed);
      case "cancelled":
        return t(($) => $.cancelled);
      default:
        return t(($) => $.unknown);
    }
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <CollectionPageHeader
        icon={BookOpenText}
        title={t(($) => $.title)}
        description={t(($) => $.description)}
      />
      {state.data?.configured === false ? (
        <p className="px-4 pt-4 text-body text-muted-foreground">
          {t(($) => $.notConfigured)}
        </p>
      ) : null}
      <Tabs
        value={tab}
        onValueChange={(value) => setTab(String(value))}
        className="min-h-0 flex-1"
      >
        <TabsList variant="line" className="mx-4 mt-3">
          <TabsTrigger value="memories">{t(($) => $.memories)}</TabsTrigger>
          <TabsTrigger value="panel">{t(($) => $.nativePanel)}</TabsTrigger>
          <TabsTrigger value="extractions">
            {t(($) => $.extractions)}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="memories" className="min-h-0 overflow-auto p-4">
          <MemoryManager />
        </TabsContent>
        <TabsContent
          value="panel"
          keepMounted
          className={`${tab === "panel" ? "flex" : "hidden"} min-h-0 flex-col px-4 pb-4 pt-2`}
        >
          <div className="mb-2 flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              disabled={panel.isFetching || !state.data?.binding}
              onClick={() => void panel.refetch()}
            >
              <RefreshCw className="size-4" />
              {t(($) => $.reloadPanel)}
            </Button>
          </div>
          {panel.data?.url ? (
            <iframe
              key={panel.data.url}
              src={panel.data.url}
              title={t(($) => $.nativePanel)}
              className="h-full min-h-96 w-full flex-1 rounded-lg border"
              referrerPolicy="no-referrer"
              sandbox="allow-scripts allow-forms allow-downloads allow-popups"
            />
          ) : (
            <p className="p-6 text-body text-muted-foreground" role="status">
              {panel.isFetching
                ? t(($) => $.loading)
                : t(($) => $.panelUnavailable)}
            </p>
          )}
        </TabsContent>
        <TabsContent value="extractions" className="min-h-0 overflow-auto p-4">
          {history.isError ? (
            <p role="alert">{t(($) => $.loadError)}</p>
          ) : history.isPending ? (
            <p role="status">{t(($) => $.loading)}</p>
          ) : history.data?.length ? (
            <ul className="space-y-3">
              {history.data.map((job) => (
                <li
                  key={job.id}
                  className="flex flex-wrap items-start justify-between gap-3 rounded-lg border p-4"
                >
                  <div className="min-w-0 flex-1">
                    <AppLink
                      href={paths.issueDetail(job.issueId)}
                      className="block break-words text-body font-medium"
                    >
                      {job.issueTitle || job.issueId}
                    </AppLink>
                    <p className="mt-1 text-caption text-muted-foreground">
                      {t(($) => $.revision, { revision: job.issueRevision })} ·{" "}
                      {new Date(job.createdAt).toLocaleString()}
                    </p>
                    {job.error ? (
                      <p className="mt-2 break-words text-body text-destructive">
                        {job.error}
                      </p>
                    ) : null}
                  </div>
                  <Badge
                    variant={
                      job.status === "failed" ? "destructive" : "secondary"
                    }
                  >
                    {statusLabel(job.status)}
                  </Badge>
                  {job.status === "failed" ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={retry.isPending}
                      onClick={() =>
                        retry.mutate(job.id, {
                          onError: () =>
                            toast.error(t(($) => $.operationError)),
                        })
                      }
                    >
                      {t(($) => $.retry)}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-body text-muted-foreground">
              {t(($) => $.noExtractions)}
            </p>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
