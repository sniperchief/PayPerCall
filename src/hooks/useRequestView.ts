import { useQuery } from '@tanstack/react-query'
import { api, ApiError } from '../lib/api'
import type { HistoryEntry } from '../lib/history'
import { describeStage } from '../lib/stages'

/** Polls the server for the request's status. The server reads the contract; the browser never decides. */
export function useRequestView(entry: HistoryEntry | null) {
  const id = entry?.created.requestId
  const token = entry?.created.accessToken
  return useQuery({
    queryKey: ['request-view', id],
    enabled: Boolean(id && token),
    queryFn: () => api.view(id!, token!),
    refetchInterval: (query) => {
      const view = query.state.data
      if (!view) return 3000
      const stage = describeStage(view)
      return stage.polling ? 2500 : view.status === 'FAILED' ? 10_000 : false
    },
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 2,
  })
}

/** Fetches the report only after the server says it is available. */
export function useReport(entry: HistoryEntry | null, available: boolean) {
  const id = entry?.created.requestId
  const token = entry?.created.accessToken
  return useQuery({
    queryKey: ['request-report', id],
    enabled: Boolean(id && token && available),
    queryFn: () => api.report(id!, token!),
    staleTime: Infinity,
    retry: 1,
  })
}
