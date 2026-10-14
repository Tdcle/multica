"use client";

import { useState } from "react";
import { Brain, ChevronDown, Link, Unlink } from "lucide-react";
import { toast } from "sonner";
import { useWorkspaceId } from "@multica/core/hooks";
import { useMemoryActions, type AgentMemory } from "@multica/core/knowledge";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "@multica/ui/components/ui/dropdown-menu";
import { Button } from "@multica/ui/components/ui/button";
import { ListGridCell } from "@multica/ui/components/ui/list-grid";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@multica/ui/components/ui/dialog";
import { CollectionPageHeaderAction } from "../../layout/collection-page";
import { MemoryManager } from "../../knowledge/memory-manager";
import { useT } from "../../i18n";

export function MemoryLibraryButton() {
  const [open, setOpen] = useState(false);
  const { t } = useT("knowledge");
  return (
    <>
      <CollectionPageHeaderAction
        icon={Brain}
        label={t(($) => $.title)}
        variant="outline"
        onClick={() => setOpen(true)}
      />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t(($) => $.title)}</DialogTitle>
            <DialogDescription>
              {t(($) => $.memoryDescription)}
            </DialogDescription>
          </DialogHeader>
          {open && <MemoryManager showDescription={false} />}
        </DialogContent>
      </Dialog>
    </>
  );
}

export function AgentMemoryCell({
  agentId,
  agentName,
  memory,
  availableMemories,
  canManage,
  loading,
  failed,
}: {
  agentId: string;
  agentName: string;
  memory?: AgentMemory;
  availableMemories: AgentMemory[];
  canManage: boolean;
  loading: boolean;
  failed: boolean;
}) {
  const { t } = useT("knowledge");
  const wsId = useWorkspaceId();
  const { bind } = useMemoryActions(wsId);
  const updateBinding = (memoryId: string | null) => {
    bind.mutate(
      { agentId, memoryId },
      {
        onError: (error) => {
          toast.error(
            error instanceof Error ? error.message : t(($) => $.operationError),
          );
        },
      },
    );
  };
  const label = (
    <span className="flex min-w-0 max-w-full items-center gap-1.5">
      <Brain aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="truncate">
        {memory?.name ||
          (loading
            ? t(($) => $.loading)
            : failed
              ? t(($) => $.loadError)
              : t(($) => $.bindMemory))}
      </span>
    </span>
  );
  return (
    <ListGridCell className="hidden @2xl:flex">
      {canManage ? (
        <span
          className="min-w-0 max-w-full"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={
                loading || failed || bind.isPending || memory?.status === "deleting"
              }
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  className="group h-auto min-w-0 max-w-full gap-1 px-1 py-1 text-caption"
                  aria-label={`${agentName} Memory`}
                />
              }
            >
              {label}
              <ChevronDown
                aria-hidden="true"
                className="size-3 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 group-data-[popup-open]:opacity-100"
              />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {memory ? (
                <DropdownMenuItem onClick={() => updateBinding(null)}>
                  <Unlink aria-hidden="true" />
                  {t(($) => $.detachMemory)}
                </DropdownMenuItem>
              ) : (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <Link aria-hidden="true" />
                    {t(($) => $.bindMemory)}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="max-h-72 max-w-64 overflow-y-auto">
                    {availableMemories.length ? (
                      availableMemories.map((available) => (
                        <DropdownMenuItem
                          key={available.id}
                          onClick={() => updateBinding(available.id)}
                        >
                          <Brain aria-hidden="true" />
                          <span className="truncate">{available.name}</span>
                        </DropdownMenuItem>
                      ))
                    ) : (
                      <DropdownMenuItem disabled>
                        {t(($) => $.noAvailableMemories)}
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      ) : memory ? (
        label
      ) : (
        <span className="text-caption text-faint-foreground">—</span>
      )}
    </ListGridCell>
  );
}
