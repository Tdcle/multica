"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BookOpenText, Loader2, Plus, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { useWorkspaceId } from "@multica/core/hooks";
import { useCurrentWorkspace, useWorkspacePaths } from "@multica/core/paths";
import { useAuthStore } from "@multica/core/auth";
import { memberListOptions } from "@multica/core/workspace/queries";
import {
  knowledgeStateOptions, knowledgeSpacesOptions, knowledgeExtractionsOptions,
  knowledgePanelOptions, useBindKnowledge, useUnbindKnowledge, useRetryKnowledgeExtraction,
} from "@multica/core/knowledge";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Badge } from "@multica/ui/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@multica/ui/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@multica/ui/components/ui/tabs";
import { CollectionPageHeader } from "../layout/collection-page";
import { AppLink } from "../navigation";
import { useT } from "../i18n";

export function KnowledgePage() {
  const wsId = useWorkspaceId();
  const workspace = useCurrentWorkspace();
  const paths = useWorkspacePaths();
  const userId = useAuthStore((state) => state.user?.id);
  const { t } = useT("knowledge");
  const state = useQuery(knowledgeStateOptions(wsId));
  const members = useQuery(memberListOptions(wsId));
  const role = members.data?.find((member) => member.user_id === userId)?.role;
  const canManage = role === "owner" || role === "admin";
  const binding = state.data?.binding;
  const [dialog, setDialog] = useState<"create" | "bind" | "detach" | null>(null);
  const [name, setName] = useState("");
  const [activeTab, setActiveTab] = useState("panel");
  const spaces = useQuery({ ...knowledgeSpacesOptions(wsId), enabled: dialog === "bind" && canManage });
  const extractions = useQuery({ ...knowledgeExtractionsOptions(wsId), enabled: Boolean(binding) });
  const panel = useQuery({ ...knowledgePanelOptions(wsId), enabled: binding?.panelAvailable === true && activeTab === "panel", retry: false });
  const bind = useBindKnowledge(wsId);
  const detach = useUnbindKnowledge(wsId);
  const retry = useRetryKnowledgeExtraction(wsId);
  const finishBinding = async (input: { name?: string; teamId?: string }) => {
    try {
      const result = await bind.mutateAsync(input);
      if (!result) throw new Error("Invalid binding response");
      setDialog(null);
    } catch { toast.error(t(($) => $.operationError)); }
  };
  const statusLabel = (status: string) => {
    switch (status) {
      case "pending": return t(($) => $.pending);
      case "processing": return t(($) => $.processing);
      case "submitted": return t(($) => $.submitted);
      case "ready": return t(($) => $.ready);
      case "failed": return t(($) => $.failed);
      default: return t(($) => $.unknown);
    }
  };

  return <div className="flex h-full min-h-0 flex-col">
    <CollectionPageHeader icon={BookOpenText} title={t(($) => $.title)} description={binding?.name || t(($) => $.description)} actions={
      canManage && binding ? <Button variant="outline" size="sm" onClick={() => setDialog("detach")}>{t(($) => $.unbind)}</Button> : undefined
    } />
    {state.isPending ? <div className="p-8 text-muted-foreground" role="status">{t(($) => $.loading)}</div> : state.isError ?
      <div className="p-8" role="alert">{t(($) => $.loadError)}</div> : !binding ?
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
        <BookOpenText className="size-8 text-muted-foreground" aria-hidden="true" />
        <h2 className="text-title font-medium">{t(($) => $.empty)}</h2>
        <p className="max-w-md text-body text-muted-foreground">{state.data?.configured === true ? t(($) => $.emptyDescription) : t(($) => $.notConfigured)}</p>
        {canManage && state.data?.configured === true ? <div className="flex flex-wrap justify-center gap-2">
          <Button onClick={() => { setName(workspace?.name ?? ""); setDialog("create"); }}><Plus className="size-4" />{t(($) => $.create)}</Button>
          <Button variant="outline" onClick={() => setDialog("bind")}>{t(($) => $.bind)}</Button>
        </div> : canManage ? null : <p className="text-body text-muted-foreground">{t(($) => $.memberWait)}</p>}
      </div> :
      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(String(value))} className="min-h-0 flex-1">
        <TabsList variant="line" className="mx-4 mt-3"><TabsTrigger value="panel">{t(($) => $.panel)}</TabsTrigger><TabsTrigger value="extractions">{t(($) => $.extractions)}</TabsTrigger></TabsList>
        <TabsContent value="panel" keepMounted className={`${activeTab === "panel" ? "flex" : "hidden"} min-h-0 flex-col px-4 pb-4 pt-2`}>
          {binding.panelAvailable === true ? <div className="mb-2 flex justify-end"><Button variant="ghost" size="sm" disabled={panel.isFetching} onClick={() => void panel.refetch()}><RefreshCw className="size-4" />{t(($) => $.reloadPanel)}</Button></div> : null}
          {panel.isPending && binding.panelAvailable === true ? <div className="p-6 text-muted-foreground" role="status">{t(($) => $.loading)}</div> : panel.data?.url ?
            <iframe key={panel.data.url} src={panel.data.url} title={t(($) => $.panel)} className="h-full min-h-96 w-full flex-1 rounded-lg border" referrerPolicy="no-referrer" sandbox="allow-scripts allow-forms allow-downloads allow-popups" /> :
            <div className="p-6 text-muted-foreground" role="status">{t(($) => $.panelUnavailable)}</div>}
        </TabsContent>
        <TabsContent value="extractions" className="min-h-0 overflow-auto px-4 py-4">
          {extractions.isError ? <p role="alert">{t(($) => $.loadError)}</p> : extractions.isPending ? <p role="status">{t(($) => $.loading)}</p> : extractions.data?.length ?
            <ul className="space-y-3">{extractions.data.map((job) => <li key={job.id} className="flex flex-wrap items-start justify-between gap-3 rounded-lg border p-4">
              <div className="min-w-0 flex-1"><AppLink href={paths.issueDetail(job.issueId)} className="block break-words text-body font-medium">{job.issueTitle || job.issueId}</AppLink><p className="mt-1 text-caption text-muted-foreground">{t(($) => $.revision, { revision: job.issueRevision })} · {new Date(job.createdAt).toLocaleString()}</p>{job.error ? <p className="mt-2 break-words text-body text-destructive">{job.error}</p> : null}</div>
              <Badge variant={job.status === "failed" ? "destructive" : "secondary"}>{statusLabel(job.status)}</Badge>
              {canManage && job.status === "failed" ? <Button variant="outline" size="sm" disabled={retry.isPending} onClick={() => retry.mutate(job.id, { onError: () => toast.error(t(($) => $.operationError)) })}>{t(($) => $.retry)}</Button> : null}
            </li>)}</ul> : <p className="text-body text-muted-foreground">{t(($) => $.noExtractions)}</p>}
        </TabsContent>
      </Tabs>}
    <Dialog open={dialog !== null} onOpenChange={(open) => { if (!open && !bind.isPending && !detach.isPending) setDialog(null); }}>
      <DialogContent><DialogHeader><DialogTitle>{dialog === "create" ? t(($) => $.create) : dialog === "bind" ? t(($) => $.bind) : t(($) => $.unbind)}</DialogTitle><DialogDescription>{dialog === "detach" ? t(($) => $.confirmUnbind) : t(($) => $.emptyDescription)}</DialogDescription></DialogHeader>
        {dialog === "create" ? <form id="knowledge-create" onSubmit={(event) => { event.preventDefault(); void finishBinding({ name: name.trim() }); }}><label htmlFor="knowledge-space-name" className="mb-2 block text-body">{t(($) => $.name)}</label><Input id="knowledge-space-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required autoFocus /></form> : dialog === "bind" ?
          <div className="max-h-80 space-y-2 overflow-auto" aria-label={t(($) => $.choose)}>{spaces.isPending ? <p role="status">{t(($) => $.loading)}</p> : spaces.isError ? <p role="alert">{t(($) => $.loadError)}</p> : spaces.data?.length ? spaces.data.map((space) => <Button key={space.id} variant="outline" className="w-full justify-start truncate" disabled={bind.isPending} onClick={() => void finishBinding({ teamId: space.id })}>{space.name}</Button>) : <p className="text-muted-foreground">{t(($) => $.empty)}</p>}</div> : null}
        <DialogFooter><Button variant="outline" disabled={bind.isPending || detach.isPending} onClick={() => setDialog(null)}>{t(($) => $.cancel)}</Button>
          {dialog === "create" ? <Button type="submit" form="knowledge-create" disabled={bind.isPending || !name.trim()}>{bind.isPending ? <Loader2 className="size-4 animate-spin" /> : null}{t(($) => $.create)}</Button> : dialog === "detach" ? <Button variant="destructive" disabled={detach.isPending} onClick={async () => { try { await detach.mutateAsync(); setDialog(null); } catch { toast.error(t(($) => $.operationError)); } }}>{t(($) => $.unbind)}</Button> : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
