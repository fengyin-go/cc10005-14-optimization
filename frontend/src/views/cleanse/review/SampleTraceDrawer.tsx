/** 单样本逐段核对抽屉：展示空值替换/格式规范化/异常值剔除/去重键四段的输入输出轨迹。 */
import { useCallback, useEffect, useState } from 'react'

import { fetchSampleDetail } from './api'
import type { SampleDetail, StageTrace } from './types'

const STAGE_BADGE: Record<string, string> = {
  null_replace: '空值替换',
  normalize: '格式规范化',
  outlier: '异常值剔除',
  dedup: '去重键',
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === '') {
    return '∅ 空值'
  }
  if (typeof value === 'object') {
    return JSON.stringify(value)
  }
  return String(value)
}

function StageBlock({ trace }: { trace: StageTrace }) {
  const [open, setOpen] = useState(false)
  const changed = trace.changes.length > 0
  return (
    <div className={`stage-block ${changed ? 'has-change' : ''}`}>
      <button className="stage-head" type="button" onClick={() => setOpen((prev) => !prev)}>
        <span className={`stage-dot ${changed ? 'dot-change' : 'dot-silent'}`} />
        <strong>{STAGE_BADGE[trace.stage] ?? trace.label}</strong>
        <span className="stage-meta">
          {changed ? `${trace.changes.length} 处变更` : '本段无变更'}
        </span>
        <span className="stage-toggle">{open ? '收起' : '展开输入/输出'}</span>
      </button>
      {open && (
        <div className="stage-body">
          <div className="stage-grid">
            <div>
              <span className="stage-caption">段输入</span>
              <pre className="stage-json">{JSON.stringify(trace.input, null, 2)}</pre>
            </div>
            <div>
              <span className="stage-caption">段输出</span>
              <pre className="stage-json">{JSON.stringify(trace.output, null, 2)}</pre>
            </div>
          </div>
          {trace.dedup_keys && Object.keys(trace.dedup_keys).length > 0 && (
            <div className="dedup-keys">
              <span className="stage-caption">去重键</span>
              {Object.entries(trace.dedup_keys).map(([code, key]) => (
                <span key={code} className="dedup-key-chip">
                  {code}：{key ?? '键列缺失，不出键'}
                </span>
              ))}
            </div>
          )}
          {trace.changes.length > 0 && (
            <table className="change-table">
              <thead>
                <tr>
                  <th>规则</th>
                  <th>字段</th>
                  <th>输入值</th>
                  <th>输出值</th>
                  <th>原因</th>
                </tr>
              </thead>
              <tbody>
                {trace.changes.map((change, index) => (
                  <tr key={`${change.field}-${index}`} className={change.blocked ? 'blocked-row' : ''}>
                    <td>{change.rule_code ?? '—'}</td>
                    <td>{change.field}</td>
                    <td className="val-before">{formatValue(change.before)}</td>
                    <td className="val-after">{formatValue(change.after)}</td>
                    <td>{change.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
}

export default function SampleTraceDrawer({
  sampleId,
  onClose,
}: {
  sampleId: string | null
  onClose: () => void
}) {
  const [detail, setDetail] = useState<SampleDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!sampleId) {
      return
    }
    setLoading(true)
    setError('')
    try {
      setDetail(await fetchSampleDetail(sampleId))
    } catch (err) {
      setError(err instanceof Error ? err.message : '明细加载失败')
    } finally {
      setLoading(false)
    }
  }, [sampleId])

  useEffect(() => {
    void load()
  }, [load])

  if (!sampleId) {
    return null
  }

  return (
    <div className="drawer-mask" role="presentation" onClick={onClose}>
      <aside className="drawer" role="dialog" aria-label="样本逐段核对" onClick={(event) => event.stopPropagation()}>
        <header className="drawer-head">
          <div>
            <h3>逐段核对 · 行 #{detail?.sample.line_no ?? '—'}（{sampleId}）</h3>
            {detail?.sample.source_unknown && (
              <span className="badge badge-unknown">未知来源：缺版本种子样例，禁止冒认启用版</span>
            )}
          </div>
          <button className="btn ghost" type="button" onClick={onClose}>关闭</button>
        </header>

        {loading && <p className="drawer-loading">正在装载四段清洗轨迹…</p>}
        {error && <p className="error-text">{error}</p>}

        {detail && (
          <div className="drawer-content">
            <section className="drawer-section">
              <h4>真实输入（预演副本隔离，不回写）</h4>
              <pre className="stage-json">{JSON.stringify(detail.sample.raw, null, 2)}</pre>
              <p className="drawer-note">
                样本日期：{detail.sample.sample_date ?? '未知'}
                {detail.sample.frozen_history === null && ' · 无历史采集结果'}
              </p>
            </section>

            <section className="drawer-section">
              <div className="branch-title">
                <h4>启用版输出</h4>
                <span className="checksum">指纹 {detail.enabled.checksum}</span>
              </div>
              {detail.enabled.stage_traces.map((trace) => (
                <StageBlock key={`enabled-${trace.stage}`} trace={trace} />
              ))}
            </section>

            <section className="drawer-section">
              <div className="branch-title">
                <h4>候选版输出</h4>
                <span className="checksum">指纹 {detail.candidate.checksum}</span>
                {detail.candidate.blocked && <span className="badge badge-blocked">预演挂起：冲突未裁决</span>}
              </div>
              {detail.candidate.stage_traces.map((trace) => (
                <StageBlock key={`candidate-${trace.stage}`} trace={trace} />
              ))}
            </section>

            <section className="drawer-section">
              <h4>差异单元格（点击对照台单元格可定位到对应样本）</h4>
              {detail.diff_cells.length === 0 ? (
                <p className="drawer-note">两版输出完全一致，无差异。</p>
              ) : (
                <table className="change-table">
                  <thead>
                    <tr>
                      <th>字段</th>
                      <th>启用版</th>
                      <th>候选版</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.diff_cells.map((cell) => (
                      <tr key={cell.field}>
                        <td>{cell.field}</td>
                        <td className="val-before">{formatValue(cell.enabled)}</td>
                        <td className="val-after">{formatValue(cell.candidate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <section className="drawer-section">
              <h4>生效日期跨样本日期的口径解释</h4>
              <ul className="caliber-list">
                {detail.candidate.caliber_notes.map((note) => (
                  <li key={`${note.rule_code}-${note.caliber}`} className={`caliber-${note.caliber}`}>
                    <span className="badge caliber-badge">{note.caliber === 'old' ? '旧口径' : '新口径'}</span>
                    {note.text}
                  </li>
                ))}
              </ul>
            </section>
          </div>
        )}
      </aside>
    </div>
  )
}
