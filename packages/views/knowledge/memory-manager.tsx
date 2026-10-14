"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  agentMemoryOptions,
  memoryListOptions,
  useMemoryActions,
  type AgentMemory,
} from "@multica/core/knowledge";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Badge } from "@multica/ui/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@multica/ui/components/ui/dialog";
import { useT } from "../i18n";
import { AppLink } from "../navigation";

export function MemoryStatus({ memory }: { memory: AgentMemory }) {
  const { t } = useT("knowledge");
  const label =
    memory.status === "ready"
      ? t(($) => $.memoryReady)
      : memory.status === "deleting"
        ? t(($) => $.memoryDeleting)
        : memory.status === "failed"
          ? t(($) => $.failed)
          : t(($) => $.memoryPending);
  return (
    <Badge variant={memory.status === "failed" ? "destructive" : "secondary"}>
      {label}
    </Badge>
  );
}

export function MemoryManager({
  agentId,
  canManage = true,
}: {
  agentId?: string;
  canManage?: boolean;
}) {
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const { t } = useT("knowledge");
  const spaces = useQuery(memoryListOptions(wsId));
  const state = useQuery({
    ...agentMemoryOptions(wsId, agentId ?? ""),
    enabled: Boolean(agentId),
  });
  const actions = useMemoryActions(wsId);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [bindingOpen, setBindingOpen] = useState(false);
  const [deleting, setDeleting] = useState<AgentMemory | null>(null);
  const [detachOpen, setDetachOpen] = useState(false);
  const run = async (action: () => Promise<unknown>, done?: () => void) => {
    try {
      await action();
      done?.();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t(($) => $.operationError),
      );
    }
  };
  const binding = state.data?.binding;
  const rows = agentId ? (binding ? [binding] : []) : (spaces.data ?? []);
  const busy =
    actions.create.isPending ||
    actions.bind.isPending ||
    actions.remove.isPending;
  return (
    <div className="space-y-4">
      <p className="text-body text-muted-foreground">
        {t(($) => $.memoryDescription)}
      </p>
      {agentId &&
        (state.isPending ? (
          <p role="status">{t(($) => $.loading)}</p>
        ) : state.isError ? (
          <p role="alert">{t(($) => $.loadError)}</p>
        ) : !binding ? (
          <p>{t(($) => $.memoryDetached)}</p>
        ) : null)}
      {!agentId && spaces.isError ? (
        <p role="alert">{t(($) => $.loadError)}</p>
      ) : null}
      {rows.map((memory) => (
        <div
          key={memory.id}
          className="flex flex-wrap items-start justify-between gap-3 rounded-lg border p-4"
        >
          <div className="min-w-0 flex-1">
            <p className="break-words text-body font-medium">{memory.name}</p>
            <p className="mt-1 break-all text-caption text-muted-foreground">
              {memory.nativeAgentId || memory.id}
            </p>
            <p className="mt-1 text-caption text-muted-foreground">
              {memory.agentId
                ? t(($) => $.memoryBound)
                : t(($) => $.memoryUnbound)}
            </p>
            {memory.error ? (
              <p
                role="alert"
                className="mt-2 break-words text-body text-destructive"
              >
                {memory.error}
              </p>
            ) : null}
          </div>
          <MemoryStatus memory={memory} />
          {canManage && memory.status !== "ready" ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void run(() => actions.retry.mutateAsync(memory.id))
              }
            >
              {t(($) => $.retry)}
            </Button>
          ) : null}
          {canManage && memory.status !== "deleting" ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDeleting(memory)}
            >
              {t(($) => $.deleteMemory)}
            </Button>
          ) : null}
        </div>
      ))}
      {agentId && canManage ? (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setBindingOpen(true)}>
            {binding ? t(($) => $.changeMemory) : t(($) => $.bindMemory)}
          </Button>
          {binding ? (
            <Button variant="outline" onClick={() => setDetachOpen(true)}>
              {t(($) => $.detachMemory)}
            </Button>
          ) : null}
          <AppLink
            href={paths.knowledge()}
            className="inline-flex items-center px-3 text-body underline"
          >
            {t(($) => $.openPanel)}
          </AppLink>
        </div>
      ) : null}
      {canManage ? (
        <Button
          variant="outline"
          onClick={() => {
            setName("");
            setCreateOpen(true);
          }}
        >
          {t(($) => $.createMemory)}
        </Button>
      ) : null}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t(($) => $.createMemory)}</DialogTitle>
            <DialogDescription>
              {t(($) => $.memoryDescription)}
            </DialogDescription>
          </DialogHeader>
          <form
            id="create-memory"
            onSubmit={(event) => {
              event.preventDefault();
              void run(
                async () => {
                  const memory = await actions.create.mutateAsync(name.trim());
                  if (!memory) throw new Error(t(($) => $.operationError));
                  if (agentId)
                    await actions.bind.mutateAsync({
                      agentId,
                      memoryId: memory.id,
                    });
                },
                () => setCreateOpen(false),
              );
            }}
          >
            <label htmlFor="memory-name" className="mb-2 block text-body">
              {t(($) => $.name)}
            </label>
            <Input
              id="memory-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={120}
              required
              autoFocus
            />
          </form>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              {t(($) => $.cancel)}
            </Button>
            <Button
              type="submit"
              form="create-memory"
              disabled={busy || !name.trim()}
            >
              {t(($) => $.createMemory)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={bindingOpen} onOpenChange={setBindingOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t(($) => $.bindMemory)}</DialogTitle>
            <DialogDescription>
              {t(($) => $.changeMemoryDescription)}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-80 space-y-2 overflow-auto">
            {spaces.isPending ? (
              <p>{t(($) => $.loading)}</p>
            ) : (
              spaces.data
                ?.filter(
                  (memory) => !memory.agentId && memory.status !== "deleting",
                )
                .map((memory) => (
                  <Button
                    key={memory.id}
                    variant="outline"
                    className="w-full justify-between"
                    disabled={busy}
                    onClick={() =>
                      void run(
                        () =>
                          actions.bind.mutateAsync({
                            agentId: agentId!,
                            memoryId: memory.id,
                          }),
                        () => setBindingOpen(false),
                      )
                    }
                  >
                    {memory.name}
                    <MemoryStatus memory={memory} />
                  </Button>
                ))
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBindingOpen(false)}>
              {t(($) => $.cancel)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={detachOpen} onOpenChange={setDetachOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t(($) => $.detachMemory)}</DialogTitle>
            <DialogDescription>
              {t(($) => $.detachMemoryDescription)}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDetachOpen(false)}>
              {t(($) => $.cancel)}
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                void run(
                  () =>
                    actions.bind.mutateAsync({
                      agentId: agentId!,
                      memoryId: null,
                    }),
                  () => setDetachOpen(false),
                )
              }
            >
              {t(($) => $.detachMemory)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t(($) => $.deleteMemory)}</DialogTitle>
            <DialogDescription>
              {t(($) => $.deleteMemoryDescription, {
                name: deleting?.name ?? "",
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>
              {t(($) => $.cancel)}
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() =>
                void run(
                  () => actions.remove.mutateAsync(deleting!.id),
                  () => setDeleting(null),
                )
              }
            >
              {t(($) => $.deleteMemory)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function MemoryDeletionChoice({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const { t } = useT("knowledge");
  return (
    <label className="flex items-start gap-2 py-3 text-body">
      <input
        type="checkbox"
        className="mt-1"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>
        {t(($) => $.deleteBoundMemory)}
        <span className="mt-1 block text-caption text-muted-foreground">
          {t(($) => $.keepMemoryDescription)}
        </span>
      </span>
    </label>
  );
}
