/** 候选版本对照台：批量样本多选 → 整组对照 → 差异单元格展开 → 冲突裁决 → 候选确认。 */
import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  confirmCandidate,
  fetchBranchRules,
  fetchOverview,
  fetchSamples,
  postCompare,
} from './api'
import CandidateRuleEditor from './CandidateRuleEditor'
import ConflictPanel from './ConflictPanel'
import SampleTraceDrawer from './SampleTraceDrawer'
import SnapshotPanel from './SnapshotPanel'
import type {
  CompareItem,
  FieldConflict,
  CleanseRule,
  ReviewOverview,
  ReviewSample,
} from './types'

function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === '') {
    return '∅'
  }
  return String(value)
}

export default function ReviewWorkbench() {
  const [samples, setSamples] = useState<ReviewSample[]>([])
  const [overview, setOverview] = useState<ReviewOverview | null>(null)
  const [candidateRules, setCandidateRules] = useState<CleanseRule[]>([])
  const [conflicts, setConflicts] = useState<FieldConflict[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [compareItems, setCompareItems] = useState<CompareItem[]>([])
  const [diffTotal, setDiffTotal] = useState(0)
  const [drawerSampleId, setDrawerSampleId] = useState<string | null>(null)
  const [snapshotRefresh, setSnapshotRefresh] = useState(0)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [confirmRemark, setConfirmRemark] = useState('')

  const refreshAll = useCallback(async () => {
    try {
      const [sampleList, overviewData, ruleData] = await Promise.all([
        fetchSamples(),
        fetchOverview(),
        fetchBranchRules('candidate'),
      ])
      setSamples(sampleList)
      setOverview(overviewData)
      setCandidateRules(ruleData.items)
      setConflicts(ruleData.conflicts)
    } catch (err) {
      setError(err instanceof Error ? err.message : '对照台数据装载失败')
    }
  }, [])

  useEffect(() => {
    void refreshAll()
  }, [refreshAll])

  const allSelected = samples.length > 0 && selected.size === samples.length

  function toggleSample(sampleId: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(sampleId)) {
        next.delete(sampleId)
      } else {
        next.add(sampleId)
      }
      return next
    })
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(samples.map((sample) => sample.sample_id)))
  }

  async function runCompare() {
    setError('')
    setNotice('')
    try {
      const payload = await postCompare([...selected])
      setCompareItems(payload.items)
      setDiffTotal(payload.diff_total)
      if (payload.items.length === 0) {
        setError('请先勾选需要复查的样本条目')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '整组对照失败')
    }
  }

  async function handleConfirm() {
    setConfirming(true)
    setError('')
    try {
      const result = await confirmCandidate(confirmRemark)
      setNotice(`${result.message}；历史采集结果${result.frozen_history_rewritten ? '已被覆写（异常）' : '保持冻结未覆写'}`)
      setConfirmRemark('')
      setSnapshotRefresh((prev) => prev + 1)
      setCompareItems([])
      await refreshAll()
    } catch (err) {
      const maybeConflict = err as Error & { code?: string; conflicts?: FieldConflict[] }
      setError(maybeConflict.message)
      if (maybeConflict.conflicts) {
        setConflicts(maybeConflict.conflicts)
      }
    } finally {
      setConfirming(false)
    }
  }

  const diffFieldSet = useMemo(() => {
    const fields = new Set<string>()
    compareItems.forEach((item) => item.diff_cells.forEach((cell) => fields.add(cell.field)))
    return [...fields]
  }, [compareItems])

  const unresolvedConflicts = conflicts.filter((item) => !item.resolved)

  return (
    <div className="review-workbench">
      <section className="review-banner">
        <div>
          <h3>候选版本对照台</h3>
          <p className="page-desc">
            批量载入带行号样本，多选复查条目后整组比较启用版与候选版；点击差异单元格可展开四段清洗的输入输出，
            修改规则只重算受影响样本分支。
          </p>
        </div>
        {overview && (
          <div className="banner-stats">
            <span className="banner-stat"><strong>{overview.sample_total}</strong>样本</span>
            <span className="banner-stat"><strong>{overview.blocked_samples}</strong>挂起</span>
            <span className="banner-stat"><strong>{unresolvedConflicts.length}</strong>未裁决冲突</span>
            <span className="banner-stat"><strong>{overview.active_snapshot ?? '—'}</strong>当前快照</span>
          </div>
        )}
      </section>

      {notice && <div className="inline-notice ok">{notice}</div>}
      {error && <div className="inline-notice error">{error}</div>}

      {/* 第一步：带行号样本多选 */}
      <section className="review-section">
        <div className="panel-title-row">
          <h4>① 批量样本（带行号，预演与真实输入隔离）</h4>
          <div className="row-actions">
            <button className="btn small" type="button" onClick={toggleAll}>
              {allSelected ? '取消全选' : '全选'}
            </button>
            <button className="btn primary small" type="button" disabled={selected.size === 0} onClick={() => void runCompare()}>
              整组比较启用版 / 候选版（已选 {selected.size} 条）
            </button>
          </div>
        </div>
        <table className="data-table compact">
          <thead>
            <tr>
              <th className="col-check">复查</th>
              <th>行号</th>
              <th>样本编号</th>
              <th>样本日期</th>
              <th>来源版本</th>
              <th>真实输入摘要</th>
              <th>历史采集结果</th>
            </tr>
          </thead>
          <tbody>
            {samples.map((sample) => (
              <tr key={sample.sample_id} className={selected.has(sample.sample_id) ? 'row-selected' : ''}>
                <td className="col-check">
                  <input
                    type="checkbox"
                    checked={selected.has(sample.sample_id)}
                    onChange={() => toggleSample(sample.sample_id)}
                  />
                </td>
                <td>#{sample.line_no}</td>
                <td>
                  <button className="link" type="button" onClick={() => setDrawerSampleId(sample.sample_id)}>
                    {sample.sample_id}
                  </button>
                </td>
                <td>{sample.sample_date ?? '—'}</td>
                <td>
                  {sample.source_unknown ? (
                    <span className="badge badge-unknown">未知来源（缺版本，禁止冒认启用版）</span>
                  ) : (
                    <span className="badge">{sample.source_version}</span>
                  )}
                </td>
                <td className="raw-summary">{Object.entries(sample.raw).map(([key, value]) => `${key}=${displayValue(value)}`).join('；')}</td>
                <td>
                  {sample.has_frozen_history ? (
                    <span className="badge badge-archived">已冻结，候选版不可覆写</span>
                  ) : (
                    <span className="badge badge-unknown">无历史结果</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* 第二步：整组对照结果 */}
      {compareItems.length > 0 && (
        <section className="review-section">
          <div className="panel-title-row">
            <h4>② 整组对照结果（共 {compareItems.length} 条，{diffTotal} 个差异单元格）</h4>
            <span className="panel-hint">点击高亮差异单元格展开该样本的四段输入输出。</span>
          </div>
          <table className="data-table compact compare-table">
            <thead>
              <tr>
                <th>行号</th>
                <th>样本</th>
                {diffFieldSet.map((field) => <th key={field}>{field}</th>)}
                <th>候选状态</th>
                <th>口径提示</th>
              </tr>
            </thead>
            <tbody>
              {compareItems.map((item) => {
                const diffMap = new Map(item.diff_cells.map((cell) => [cell.field, cell]))
                const oldCaliber = item.caliber_notes.filter((note) => note.caliber === 'old')
                return (
                  <tr key={item.sample_id}>
                    <td>#{item.line_no}</td>
                    <td>
                      <button className="link" type="button" onClick={() => setDrawerSampleId(item.sample_id)}>
                        {item.sample_id}
                      </button>
                      {item.source_unknown && <span className="badge badge-unknown">未知来源</span>}
                    </td>
                    {diffFieldSet.map((field) => {
                      const cell = diffMap.get(field)
                      if (!cell) {
                        return <td key={field} className="cell-same">{displayValue(item.candidate_output[field])}</td>
                      }
                      return (
                        <td key={field} className="cell-diff" title="点击展开四段输入输出">
                          <button type="button" className="diff-cell" onClick={() => setDrawerSampleId(item.sample_id)}>
                            <span className="diff-before">{displayValue(cell.enabled)}</span>
                            <span className="diff-arrow">→</span>
                            <span className="diff-after">{displayValue(cell.candidate)}</span>
                          </button>
                        </td>
                      )
                    })}
                    <td>
                      {item.candidate_blocked && <span className="badge badge-blocked">预演挂起</span>}
                      {item.candidate_dedup_flag && (
                        <span className="badge badge-warn" title={item.candidate_dedup_reason ?? ''}>候选判重</span>
                      )}
                      {!item.candidate_blocked && !item.candidate_dedup_flag && <span className="badge badge-ok">可核对</span>}
                    </td>
                    <td className="caliber-cell">
                      {oldCaliber.length > 0 ? (
                        <span className="badge badge-warn">
                          {oldCaliber.length} 条规则未生效（样本日期早于生效日，沿用旧口径）
                        </span>
                      ) : (
                        <span className="badge badge-ok">全部按新生效口径</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </section>
      )}

      {/* 第三步：冲突裁决 */}
      <section className="review-section">
        <ConflictPanel
          conflicts={conflicts}
          onResolved={(message) => {
            setNotice(message)
            void refreshAll()
          }}
          onError={setError}
        />
      </section>

      {/* 第四步：候选规则编辑 */}
      <section className="review-section">
        <CandidateRuleEditor
          rules={candidateRules}
          onSaved={(message, ids) => {
            setNotice(`${message}；重算样本：${ids.join('、')}`)
            void refreshAll()
          }}
          onError={setError}
        />
      </section>

      {/* 第五步：一次提交候选确认 */}
      <section className="review-section confirm-section">
        <div className="panel-title-row">
          <h4>③ 一次提交候选确认</h4>
          <span className="panel-hint">
            确认后生成不可变清洗快照供字段映射/作业引用；未确认试验分支不可被作业选中，历史采集结果不会被覆写。
          </span>
        </div>
        <div className="confirm-bar">
          <input
            className="confirm-remark"
            placeholder="确认备注（可选），例如：收紧价格异常上限、补充城市兜底口径"
            value={confirmRemark}
            onChange={(event) => setConfirmRemark(event.target.value)}
          />
          <button className="btn primary" type="button" disabled={confirming} onClick={() => void handleConfirm()}>
            {confirming ? '确认中…' : '确认候选版并生成快照'}
          </button>
        </div>
        {unresolvedConflicts.length > 0 && (
          <p className="error-text">
            仍有 {unresolvedConflicts.length} 个同字段冲突未裁决，确认将被后端拦截：
            {unresolvedConflicts.map((item) => ` ${item.field}（${item.stage_label}）`).join('、')}
          </p>
        )}
      </section>

      {/* 第六步：快照与重演 */}
      <section className="review-section">
        <SnapshotPanel refreshKey={snapshotRefresh} onError={setError} />
      </section>

      <SampleTraceDrawer sampleId={drawerSampleId} onClose={() => setDrawerSampleId(null)} />
    </div>
  )
}
