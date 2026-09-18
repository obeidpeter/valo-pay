import { useRef } from 'react';
import { useMutation, type UseMutationOptions } from '@tanstack/react-query';
import {
  performAction, createRecord, updateRecord, updateSettings, importRecords, createExport, retryExportJob,
  type PerformActionMutationVariables, type CreateRecordMutationVariables,
  type UpdateRecordMutationVariables, type UpdateSettingsMutationVariables,
  type ImportRecordsMutationVariables, type CreateExportMutationVariables, type RetryExportJobMutationVariables,
} from '@workspace/api-client-react';

/** Object key order must not turn an unchanged retry into another operation. */
export function submissionFingerprint(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}

type RequestOptions = Parameters<typeof performAction>[2];
type Options<Result, Variables> = { mutation?: UseMutationOptions<Result, Error, Variables>; request?: RequestOptions };

/**
 * A key belongs to one form/action session and unchanged payload (including lender).
 * Keep it when a response is lost: the server can replay its already committed result.
 * Success or a changed submission starts a fresh intention. Nothing is persisted locally.
 */
function useSafeMutation<Result, Variables>(send: (variables: Variables, request: RequestOptions) => Promise<Result>, options: Options<Result, Variables> = {}, scope?: unknown) {
  const attempt = useRef<{ fingerprint: string; key: string } | null>(null);
  const previousScope = useRef(scope);
  if (previousScope.current !== scope) { previousScope.current = scope; attempt.current = null; }
  return useMutation<Result, Error, Variables>({
    ...options.mutation,
    retry: false,
    mutationFn: async variables => {
      const fingerprint = submissionFingerprint(variables);
      if (!attempt.current || attempt.current.fingerprint !== fingerprint) attempt.current = { fingerprint, key: crypto.randomUUID() };
      const current = attempt.current;
      const headers = new Headers(options.request?.headers);
      headers.set('Idempotency-Key', current.key);
      const result = await send(variables, { ...options.request, headers });
      if (attempt.current === current) attempt.current = null;
      return result;
    },
  });
}

export function useSafePerformAction(options?: Options<Awaited<ReturnType<typeof performAction>>, PerformActionMutationVariables>, scope?: unknown) {
  return useSafeMutation((v: PerformActionMutationVariables, request) => performAction(v.data, v.params, request), options, scope);
}
export function useSafeCreateRecord(options?: Options<Awaited<ReturnType<typeof createRecord>>, CreateRecordMutationVariables>, scope?: unknown) {
  return useSafeMutation((v: CreateRecordMutationVariables, request) => createRecord(v.kind, v.data, v.params, request), options, scope);
}
export function useSafeUpdateRecord(options?: Options<Awaited<ReturnType<typeof updateRecord>>, UpdateRecordMutationVariables>, scope?: unknown) {
  return useSafeMutation((v: UpdateRecordMutationVariables, request) => updateRecord(v.kind, v.id, v.data, v.params, request), options, scope);
}
export function useSafeUpdateSettings(options?: Options<Awaited<ReturnType<typeof updateSettings>>, UpdateSettingsMutationVariables>, scope?: unknown) {
  return useSafeMutation((v: UpdateSettingsMutationVariables, request) => updateSettings(v.data, v.params, request), options, scope);
}
export function useSafeImportRecords(options?: Options<Awaited<ReturnType<typeof importRecords>>, ImportRecordsMutationVariables>, scope?: unknown) {
  return useSafeMutation((v: ImportRecordsMutationVariables, request) => importRecords(v.data, v.params, request), options, scope);
}
export function useSafeCreateExport(options?: Options<Awaited<ReturnType<typeof createExport>>, CreateExportMutationVariables>, scope?: unknown) {
  return useSafeMutation((v: CreateExportMutationVariables, request) => createExport(v.data, v.params, request), options, scope);
}
export function useSafeRetryExportJob(options?: Options<Awaited<ReturnType<typeof retryExportJob>>, RetryExportJobMutationVariables>, scope?: unknown) {
  return useSafeMutation((v: RetryExportJobMutationVariables, request) => retryExportJob(v.id, v.params, request), options, scope);
}
