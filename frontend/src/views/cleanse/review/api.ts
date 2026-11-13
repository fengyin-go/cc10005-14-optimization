/** 对照台接口封装：统一路径前缀与 JSON 出入参，错误直接抛出可读消息。 */
import { request } from '@/api/client'

import type {
  CompareItem,
  FieldConflict,
  CleanseRule,
  JobContext,
  ReplayResult,
  ReviewOverview,
  ReviewSample,
  SampleDetail,
  Snapshot,
} from './types'

const BASE = '/api/cleanse/review'

async function readJson<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(payload?.message ? String(payload.message) : `接口返回 ${response.status}`)
  }
  return payload as T
}

export async function fetchSamples(): Promise<ReviewSample[]> {
  const response = await request(`${BASE}/samples`)
  const payload = await readJson<{ items: ReviewSample[] }>(response)
  return payload.items
}

export async function fetchOverview(): Promise<ReviewOverview> {
  const response = await request(`${BASE}/overview`)
  return readJson<ReviewOverview>(response)
}

export async function fetchBranchRules(
  branch: 'enabled' | 'candidate',
): Promise<{ items: CleanseRule[]; conflicts: FieldConflict[] }> {
  const response = await request(`${BASE}/rules/${branch}`)
  return readJson(response)
}

export async function updateCandidateRule(
  ruleCode: string,
  values: Record<string, unknown>,
): Promise<{ message: string; recomputed_sample_ids: string[]; affected_stage: string }> {
  const response = await request(`${BASE}/rules/candidate/${ruleCode}`, {
    method: 'PUT',
    body: JSON.stringify({ values }),
  })
  const payload = await readJson<{ ok: boolean; message: string; recomputed_sample_ids: string[]; affected_stage: string }>(response)
  if (payload.ok === false) {
    throw new Error(payload.message)
  }
  return payload
}

export async function resolveConflict(payload: {
  field: string
  ordered_rule_codes: string[]
  policy: 'first_wins' | 'last_wins'
}): Promise<{ message: string; recomputed_sample_ids: string[]; conflicts: FieldConflict[] }> {
  const response = await request(`${BASE}/conflicts/resolve`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  const data = await readJson<{ ok: boolean; message: string; recomputed_sample_ids: string[]; conflicts: FieldConflict[] }>(response)
  if (data.ok === false) {
    throw new Error(data.message)
  }
  return data
}

export async function postCompare(sampleIds: string[]): Promise<{ items: CompareItem[]; diff_total: number }> {
  const response = await request(`${BASE}/compare`, {
    method: 'POST',
    body: JSON.stringify({ sample_ids: sampleIds }),
  })
  const payload = await readJson<{ ok: boolean; message?: string; items: CompareItem[]; diff_total: number }>(response)
  if (payload.ok === false) {
    throw new Error(payload.message ?? '对照失败')
  }
  return payload
}

export async function fetchSampleDetail(sampleId: string): Promise<SampleDetail> {
  const response = await request(`${BASE}/samples/${sampleId}/detail`)
  const payload = await readJson<{ ok: boolean; message?: string } & SampleDetail>(response)
  if (payload.ok === false) {
    throw new Error(payload.message ?? '样本明细读取失败')
  }
  return payload
}

export async function confirmCandidate(remark: string): Promise<{
  message: string
  snapshot: Snapshot
  frozen_history_rewritten: boolean
}> {
  const response = await request(`${BASE}/confirm`, {
    method: 'POST',
    body: JSON.stringify({ remark }),
  })
  const payload = await readJson<{
    ok: boolean
    message: string
    code?: string
    conflicts?: FieldConflict[]
    snapshot?: Snapshot
    frozen_history_rewritten?: boolean
  }>(response)
  if (payload.ok === false) {
    const error = new Error(payload.message) as Error & { code?: string; conflicts?: FieldConflict[] }
    error.code = payload.code
    error.conflicts = payload.conflicts
    throw error
  }
  return {
    message: payload.message,
    snapshot: payload.snapshot as Snapshot,
    frozen_history_rewritten: Boolean(payload.frozen_history_rewritten),
  }
}

export async function fetchSnapshots(): Promise<{ items: Snapshot[]; selectable_for_jobs: string[] }> {
  const response = await request(`${BASE}/snapshots`)
  return readJson(response)
}

export async function fetchJobContext(): Promise<JobContext> {
  const response = await request(`${BASE}/job-context`)
  return readJson(response)
}

export async function postReplay(snapshotId: string, sampleIds: string[] = []): Promise<ReplayResult> {
  const response = await request(`${BASE}/replay`, {
    method: 'POST',
    body: JSON.stringify({ snapshot_id: snapshotId, sample_ids: sampleIds }),
  })
  const payload = await readJson<ReplayResult & { message?: string }>(response)
  if (payload.ok === false) {
    throw new Error(payload.message ?? '重演失败')
  }
  return payload
}
