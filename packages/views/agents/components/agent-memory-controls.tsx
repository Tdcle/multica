"use client";

import { useState } from "react";
import { Brain } from "lucide-react";
import type { AgentMemory } from "@multica/core/knowledge";
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
import { MemoryManager, MemoryStatus } from "../../knowledge/memory-manager";
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
  canManage,
  loading,
  failed,
}: {
  agentId: string;
  agentName: string;
  memory?: AgentMemory;
  canManage: boolean;
  loading: boolean;
  failed: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { t } = useT("knowledge");
  return (
    <ListGridCell className="hidden @2xl:flex">
      {canManage || memory ? (
        <>
          <Button
            variant="ghost"
            size="sm"
            className="h-auto min-w-0 max-w-full flex-col items-start gap-1 px-1 py-1 text-caption"
            aria-label={`${agentName} Memory`}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setOpen(true);
            }}
            onKeyDown={(event) => event.stopPropagation()}
          >
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
            {memory && <MemoryStatus memory={memory} />}
          </Button>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent
              className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl"
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <DialogHeader>
                <DialogTitle>{agentName} · Memory</DialogTitle>
                <DialogDescription>
                  {t(($) => $.memoryDescription)}
                </DialogDescription>
              </DialogHeader>
              {open && (
                <MemoryManager
                  agentId={agentId}
                  canManage={canManage}
                  showDescription={false}
                />
              )}
            </DialogContent>
          </Dialog>
        </>
      ) : (
        <span className="text-caption text-faint-foreground">—</span>
      )}
    </ListGridCell>
  );
}
