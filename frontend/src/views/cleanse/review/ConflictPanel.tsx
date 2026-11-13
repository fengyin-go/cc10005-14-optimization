/** 同字段冲突裁决面板：先确定规则先后顺序，再选择冲突裁决策略。 */
import { useState } from 'react'

import { resolveConflict } from './api'
import type { FieldConflict } from './types'

const POLICY_TEXT: Record<string, string> = {
  first_wins: '先者生效（排在前面的规则写入后，后者不再覆盖）',
  last_wins: '后者覆盖（排在后面的规则最终写入）',
}

export default function ConflictPanel({
  conflicts,
  onResolved,
  onError,
}: {
  conflicts: FieldConflict[]
  onResolved: (message: string) => void
  onError: (message: string) => void
}) {
  const [orders, setOrders] = useState<Record<string, string[]>>({})
  const [policies, setPolicies] = useState<Record<string, 'first_wins' | 'last_wins'>>({})
  const [submitting, setSubmitting] = useState<string | null>(null)

  if (conflicts.length === 0) {
    return (
      <div className="conflict-panel clean">
        <span className="badge badge-ok">无同字段冲突</span>
        <span className="panel-hint">所有写同一字段的清洗规则都已确定先后与裁决口径。</span>
      </div>
    )
  }

  async function submit(conflict: FieldConflict) {
    const order = orders[conflict.field] ?? conflict.rule_codes
    const policy = policies[conflict.field]
    if (!policy) {
      onError(`请先为字段「${conflict.field}」选择冲突裁决策略`)
      return
    }
    setSubmitting(conflict.field)
    try {
      const result = await resolveConflict({
        field: conflict.field,
        ordered_rule_codes: order,
        policy,
      })
      onResolved(`${result.message}（重算 ${result.recomputed_sample_ids.length} 条样本分支）`)
    } catch (error) {
      onError(error instanceof Error ? error.message : '冲突裁决提交失败')
    } finally {
      setSubmitting(null)
    }
  }

  function move(conflict: FieldConflict, index: number, direction: -1 | 1) {
    const base = orders[conflict.field] ? [...(orders[conflict.field] ?? [])] : [...conflict.rule_codes]
    const target = index + direction
    if (target < 0 || target >= base.length) {
      return
    }
    ;[base[index], base[target]] = [base[target], base[index]]
    setOrders((prev) => ({ ...prev, [conflict.field]: base }))
  }

  return (
    <div className="conflict-panel">
      <div className="panel-title-row">
        <h4>同字段冲突裁决</h4>
        <span className="panel-hint">两项清洗写同一字段时，必须先确定先后及冲突裁决，才能确认候选版。</span>
      </div>
      {conflicts.map((conflict) => {
        const order = orders[conflict.field] ?? conflict.rule_codes
        const policy = policies[conflict.field]
        return (
          <article key={`${conflict.field}-${conflict.stage}`} className={`conflict-card ${conflict.resolved ? 'resolved' : ''}`}>
            <header>
              <strong>{conflict.field}</strong>
              <span className="badge">{conflict.stage_label}段</span>
              {conflict.resolved && <span className="badge badge-ok">已裁决</span>}
            </header>
            <ol className="rule-order-list">
              {order.map((code, index) => (
                <li key={code}>
                  <span className="order-index">{index + 1}</span>
                  <span className="order-code">{code}</span>
                  <span className="order-actions">
                    <button type="button" className="link" disabled={index === 0} onClick={() => move(conflict, index, -1)}>
                      上移
                    </button>
                    <button
                      type="button"
                      className="link"
                      disabled={index === order.length - 1}
                      onClick={() => move(conflict, index, 1)}
                    >
                      下移
                    </button>
                  </span>
                </li>
              ))}
            </ol>
            <div className="policy-row">
              {(['first_wins', 'last_wins'] as const).map((value) => (
                <label key={value} className={`policy-option ${policy === value ? 'selected' : ''}`}>
                  <input
                    type="radio"
                    name={`policy-${conflict.field}`}
                    checked={policy === value}
                    onChange={() => setPolicies((prev) => ({ ...prev, [conflict.field]: value }))}
                  />
                  <span>{POLICY_TEXT[value]}</span>
                </label>
              ))}
            </div>
            <button className="btn primary small" type="button" disabled={submitting === conflict.field} onClick={() => void submit(conflict)}>
              {submitting === conflict.field ? '提交中…' : '提交裁决并重算受影响分支'}
            </button>
          </article>
        )
      })}
    </div>
  )
}
