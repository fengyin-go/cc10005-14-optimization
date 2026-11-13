/** 候选规则编辑器：按段位编辑参数，保存后后端只重算受影响样本分支。 */
import { useState } from 'react'

import { updateCandidateRule } from './api'
import type { CleanseRule } from './types'

const STAGE_TEXT: Record<string, string> = {
  null_replace: '空值替换',
  normalize: '格式规范化',
  outlier: '异常值剔除',
  dedup: '去重键',
}

const NORM_OPTIONS = [
  { value: 'trim', label: '去首尾空格' },
  { value: 'upper', label: '统一大写' },
  { value: 'lower', label: '统一小写' },
  { value: 'digits', label: '仅保留数字' },
  { value: 'halfwidth', label: '全角转半角' },
]

interface EditingState {
  null_replacement: string
  normalize_ops: string[]
  outlier_min: string
  outlier_max: string
  dedup_columns_text: string
  effective_date: string
}

function toEditingState(rule: CleanseRule): EditingState {
  return {
    null_replacement: rule.null_replacement ?? '',
    normalize_ops: [...rule.normalize_ops],
    outlier_min: rule.outlier_bounds?.min?.toString() ?? '',
    outlier_max: rule.outlier_bounds?.max?.toString() ?? '',
    dedup_columns_text: rule.dedup_columns.join(','),
    effective_date: rule.effective_date,
  }
}

export default function CandidateRuleEditor({
  rules,
  onSaved,
  onError,
}: {
  rules: CleanseRule[]
  onSaved: (message: string, recomputedIds: string[]) => void
  onError: (message: string) => void
}) {
  const [openCode, setOpenCode] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, EditingState>>({})
  const [savingCode, setSavingCode] = useState<string | null>(null)

  function draftOf(rule: CleanseRule): EditingState {
    return drafts[rule.rule_code] ?? toEditingState(rule)
  }

  function patch(rule: CleanseRule, updater: (draft: EditingState) => EditingState) {
    setDrafts((prev) => ({
      ...prev,
      [rule.rule_code]: updater(draftOf(rule)),
    }))
  }

  async function save(rule: CleanseRule) {
    const draft = draftOf(rule)
    const values: Record<string, unknown> = { effective_date: draft.effective_date }
    if (rule.stage === 'null_replace') {
      values.null_replacement = draft.null_replacement
    }
    if (rule.stage === 'normalize') {
      values.normalize_ops = draft.normalize_ops
    }
    if (rule.stage === 'outlier') {
      values.outlier_bounds = {
        min: draft.outlier_min === '' ? null : Number(draft.outlier_min),
        max: draft.outlier_max === '' ? null : Number(draft.outlier_max),
      }
    }
    if (rule.stage === 'dedup') {
      values.dedup_columns = draft.dedup_columns_text
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    }
    setSavingCode(rule.rule_code)
    try {
      const result = await updateCandidateRule(rule.rule_code, values)
      onSaved(result.message, result.recomputed_sample_ids)
      setOpenCode(null)
    } catch (error) {
      onError(error instanceof Error ? error.message : '规则保存失败')
    } finally {
      setSavingCode(null)
    }
  }

  return (
    <div className="rule-editor">
      <div className="panel-title-row">
        <h4>候选版（试验分支）规则</h4>
        <span className="panel-hint">未确认前仅用于预演，作业与字段映射不可选中该分支。</span>
      </div>
      <table className="data-table compact">
        <thead>
          <tr>
            <th>规则</th>
            <th>段位</th>
            <th>目标字段</th>
            <th>当前口径</th>
            <th>生效日期</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {rules.map((rule) => {
            const draft = draftOf(rule)
            const open = openCode === rule.rule_code
            return (
              <tr key={rule.rule_code} className={open ? 'editor-open' : ''}>
                <td>
                  <strong>{rule.rule_code}</strong>
                  <span className="rule-name">{rule.rule_name}</span>
                </td>
                <td><span className="badge">{STAGE_TEXT[rule.stage]}</span></td>
                <td>{rule.target_field}</td>
                <td className="caliber-cell">
                  {rule.stage === 'null_replace' && `空值 → ${rule.null_replacement ?? '∅'}`}
                  {rule.stage === 'normalize' && (rule.normalize_ops.length ? rule.normalize_ops.join(' → ') : '无规范化')}
                  {rule.stage === 'outlier' &&
                    rule.outlier_bounds &&
                    `区间 [${rule.outlier_bounds.min ?? '−∞'}, ${rule.outlier_bounds.max ?? '+∞'}] 之外剔除`}
                  {rule.stage === 'dedup' && `键列：${rule.dedup_columns.join(' + ') || '未配置'}`}
                </td>
                <td>{rule.effective_date}</td>
                <td>
                  <button className="link" type="button" onClick={() => setOpenCode(open ? null : rule.rule_code)}>
                    {open ? '收起编辑' : '修改规则'}
                  </button>
                </td>
                {open && (
                  <td colSpan={6} className="editor-cell">
                    <div className="editor-form">
                      <label className="filter-item">
                        <span>生效日期（跨样本日期时分别解释新旧口径）</span>
                        <input
                          type="date"
                          value={draft.effective_date}
                          onChange={(event) => patch(rule, (prev) => ({ ...prev, effective_date: event.target.value }))}
                        />
                      </label>
                      {rule.stage === 'null_replace' && (
                        <label className="filter-item">
                          <span>空值替换为</span>
                          <input
                            value={draft.null_replacement}
                            onChange={(event) => patch(rule, (prev) => ({ ...prev, null_replacement: event.target.value }))}
                          />
                        </label>
                      )}
                      {rule.stage === 'normalize' && (
                        <fieldset className="norm-options">
                          <legend>规范化口径（按勾选顺序组合）</legend>
                          {NORM_OPTIONS.map((option) => (
                            <label key={option.value} className="check-chip">
                              <input
                                type="checkbox"
                                checked={draft.normalize_ops.includes(option.value)}
                                onChange={(event) =>
                                  patch(rule, (prev) => ({
                                    ...prev,
                                    normalize_ops: event.target.checked
                                      ? [...prev.normalize_ops, option.value]
                                      : prev.normalize_ops.filter((item) => item !== option.value),
                                  }))
                                }
                              />
                              {option.label}
                            </label>
                          ))}
                        </fieldset>
                      )}
                      {rule.stage === 'outlier' && (
                        <div className="bounds-row">
                          <label className="filter-item">
                            <span>数值下限</span>
                            <input
                              value={draft.outlier_min}
                              placeholder="留空表示不限"
                              onChange={(event) => patch(rule, (prev) => ({ ...prev, outlier_min: event.target.value }))}
                            />
                          </label>
                          <label className="filter-item">
                            <span>数值上限</span>
                            <input
                              value={draft.outlier_max}
                              placeholder="留空表示不限"
                              onChange={(event) => patch(rule, (prev) => ({ ...prev, outlier_max: event.target.value }))}
                            />
                          </label>
                        </div>
                      )}
                      {rule.stage === 'dedup' && (
                        <label className="filter-item">
                          <span>去重键列（英文逗号分隔，批次级规则改动会全量重算）</span>
                          <input
                            value={draft.dedup_columns_text}
                            onChange={(event) => patch(rule, (prev) => ({ ...prev, dedup_columns_text: event.target.value }))}
                          />
                        </label>
                      )}
                      <button className="btn primary small" type="button" disabled={savingCode === rule.rule_code} onClick={() => void save(rule)}>
                        {savingCode === rule.rule_code ? '保存并重算中…' : '保存并重算受影响样本分支'}
                      </button>
                    </div>
                  </td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
