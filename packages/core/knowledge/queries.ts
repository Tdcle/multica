import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";

export const knowledgeKeys = {
  all: (wsId: string) => ["knowledge", wsId] as const,
  state: (wsId: string) => ["knowledge", wsId, "binding"] as const,
  spaces: (wsId: string) => ["knowledge", wsId, "spaces"] as const,
  extractions: (wsId: string) => ["knowledge", wsId, "extractions"] as const,
  panel: (wsId: string) => ["knowledge", wsId, "panel"] as const,
};

export function knowledgeStateOptions(wsId: string) {
  return queryOptions({ queryKey: knowledgeKeys.state(wsId), queryFn: () => api.getKnowledgeState(wsId) });
}
export function knowledgeSpacesOptions(wsId: string) {
  return queryOptions({ queryKey: knowledgeKeys.spaces(wsId), queryFn: () => api.listKnowledgeSpaces(wsId) });
}
export function knowledgeExtractionsOptions(wsId: string) {
  return queryOptions({ queryKey: knowledgeKeys.extractions(wsId), queryFn: () => api.listKnowledgeExtractions(wsId), refetchInterval: 5000 });
}
export function knowledgePanelOptions(wsId: string) {
  return queryOptions({ queryKey: knowledgeKeys.panel(wsId), queryFn: () => api.createKnowledgePanelSession(wsId), staleTime: 50 * 60_000, refetchOnWindowFocus: false });
}
export function useBindKnowledge(wsId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { teamId?: string; name?: string }) => api.bindKnowledge(wsId, input),
    onSuccess: () => client.invalidateQueries({ queryKey: knowledgeKeys.all(wsId) }),
  });
}
export function useUnbindKnowledge(wsId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.unbindKnowledge(wsId),
    onSuccess: () => { client.removeQueries({ queryKey: knowledgeKeys.panel(wsId) }); return client.invalidateQueries({ queryKey: knowledgeKeys.all(wsId) }); },
  });
}
export function useRetryKnowledgeExtraction(wsId: string) {
  const client = useQueryClient();
  return useMutation({ mutationFn: (id: string) => api.retryKnowledgeExtraction(wsId, id), onSuccess: () => client.invalidateQueries({ queryKey: knowledgeKeys.extractions(wsId) }) });
}
