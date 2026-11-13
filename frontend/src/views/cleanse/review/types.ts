/** 清洗版本对照台接口类型定义。 */

export type StageKey = 'null_replace' | 'normalize' | 'outlier' | 'dedup'

export interface StageChange {
  field: string
  before: unknown
  after: unknown
  reason: string
  rule_code?: string
  blocked?: boolean
  rule_codes?: string[]
}

export interface StageTrace {
  stage: StageKey
  label: string
  input: Record<string, unknown>
  output: Record<string, unknown>
  changes: StageChange[]
  dedup_keys?: Record<string, string | null>
}

export interface CaliberNote {
  rule_code: string
  effective_date: string
  sample_date: string
  caliber: 'old' | 'new'
  text: string
}

export interface ReviewSample {
  sample_id: string
  line_no: number
  sample_date: string | null
  source_version: string | null
  source_unknown: boolean
  raw: Record<string, unknown>
  has_frozen_history: boolean
}

export interface CleanseRule {
  rule_code: string
  rule_name: string
  branch: 'enabled' | 'candidate'
  version: string
  stage: StageKey
  target_field: string
  null_replacement: string | null
  normalize_ops: string[]
  outlier_bounds: { min: number | null; max: number | null } | null
  dedup_columns: string[]
  effective_date: string
}

export interface FieldConflict {
  field: string
  stage: StageKey
  stage_label: string
  rule_codes: string[]
  ordered_codes: string[]
  policy: 'first_wins' | 'last_wins' | null
  resolved: boolean
}

export interface DiffCell {
  field: string
  enabled: unknown
  candidate: unknown
}

export interface CompareItem {
  sample_id: string
  line_no: number
  sample_date: string | null
  source_version: string | null
  source_unknown: boolean
  enabled_output: Record<string, unknown>
  candidate_output: Record<string, unknown>
  diff_cells: DiffCell[]
  diff_count: number
  candidate_blocked: boolean
  candidate_dedup_flag: boolean
  candidate_dedup_reason: string | null
  enabled_dedup_flag: boolean
  caliber_notes: CaliberNote[]
}

export interface SampleDetail {
  sample: {
    sample_id: string
    line_no: number
    sample_date: string | null
    source_version: string | null
    source_unknown: boolean
    raw: Record<string, unknown>
    frozen_history: Record<string, unknown> | null
  }
  enabled: {
    output: Record<string, unknown>
    stage_traces: StageTrace[]
    checksum: string
    caliber_notes: CaliberNote[]
  }
  candidate: {
    output: Record<string, unknown>
    stage_traces: StageTrace[]
    checksum: string
    blocked: boolean
    caliber_notes: CaliberNote[]
  }
  diff_cells: DiffCell[]
}

export interface Snapshot {
  snapshot_id: string
  version: string
  status: 'active' | 'archived'
  rule_count: number
  checksum: string
  field_pipeline: Record<string, string[]>
  conflict_policy: Record<string, string>
  confirmed_at: string
  remark: string
}

export interface ReviewOverview {
  sample_total: number
  enabled_rule_total: number
  candidate_rule_total: number
  diff_field_counts: Record<string, number>
  blocked_samples: number
  unresolved_conflicts: FieldConflict[]
  snapshot_total: number
  active_snapshot: string | null
  mapping_snapshot_id?: string
}

export interface JobContext {
  mapping_module: string
  pinned_snapshot_id: string
  pinned_exists: boolean
  selectable_snapshot_ids: string[]
  trial_branch_selectable: boolean
  note: string
}

export interface ReplayItem {
  sample_id: string
  line_no: number
  output: Record<string, unknown>
  checksum: string
  frozen_history: Record<string, unknown> | null
  history_overwritten: boolean
  history_match: boolean
}

export interface ReplayResult {
  ok: boolean
  snapshot_id: string
  snapshot_checksum: string
  replay_checksum: string
  deterministic: boolean
  items: ReplayItem[]
  notice: string
}
