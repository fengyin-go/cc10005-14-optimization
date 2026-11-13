/** 快照与重演面板：确认后的清洗快照供作业选择，并支持同输入同快照的确定性重演。 */
import { useCallback, useEffect, useState } from 'react'

import { fetchJobContext, fetchSnapshots, postReplay } from './api'
import type { JobContext, ReplayResult, Snapshot } from './types'

export default function SnapshotPanel({
  refreshKey,
  onError,
}: {
  refreshKey: number
  onError: (message: string) => void
}) {
  const [snapshots, setSnapshots] = useState<Snapshot[]>([])
  const [selectable, setSelectable] = useState<string[]>([])
  const [jobContext, setJobContext] = useState<JobContext | null>(null)
  const [replay, setReplay] = useState<ReplayResult | null>(null)
  const [running, setRunning] = useState(false)

  const load = useCallback(async () => {
    try {
      const [payload, context] = await Promise.all([fetchSnapshots(), fetchJobContext()])
      setSnapshots(payload.items)
      setSelectable(payload.selectable_for_jobs)
      setJobContext(context)
    } catch (error) {
      onError(error instanceof Error ? error.message : '快照清单读取失败')
    }
  }, [onError])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  async function runReplay(snapshotId: string) {
    setRunning(true)
    try {
      setReplay(await postReplay(snapshotId))
    } catch (error) {
      onError(error instanceof Error ? error.message : '重演失败')
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="snapshot-panel">
      <div className="panel-title-row">
        <h4>清洗快照与重演对账</h4>
        <span className="panel-hint">字段映射模块只引用已确认快照；未确认的试验分支不会出现在作业可选列表。</span>
      </div>

      {jobContext && (
        <div className="job-context-bar">
          <span className="badge badge-ok">字段映射（{jobContext.mapping_module}）当前引用：{jobContext.pinned_snapshot_id}</span>
          <span className="badge badge-archived">作业可选快照：{jobContext.selectable_snapshot_ids.join('、') || '无'}</span>
          <span className={`badge ${jobContext.trial_branch_selectable ? 'badge-blocked' : 'badge-ok'}`}>
            未确认试验分支可被作业选中：{jobContext.trial_branch_selectable ? '是（异常）' : '否（已禁止）'}
          </span>
          <span className="panel-hint">{jobContext.note}</span>
        </div>
      )}

      <table className="data-table compact">
        <thead>
          <tr>
            <th>快照编号</th>
            <th>版本</th>
            <th>状态</th>
            <th>规则数</th>
            <th>指纹</th>
            <th>确认时间</th>
            <th>说明</th>
            <th>重演</th>
          </tr>
        </thead>
        <tbody>
          {snapshots.map((snapshot) => {
            const jobSelectable = selectable.includes(snapshot.snapshot_id)
            return (
              <tr key={snapshot.snapshot_id}>
                <td>
                  <strong>{snapshot.snapshot_id}</strong>
                  {jobSelectable && <span className="badge badge-ok">作业可选</span>}
                </td>
                <td>{snapshot.version}</td>
                <td>
                  <span className={`badge ${snapshot.status === 'active' ? 'badge-ok' : 'badge-archived'}`}>
                    {snapshot.status === 'active' ? '启用中' : '已归档'}
                  </span>
                </td>
                <td>{snapshot.rule_count}</td>
                <td><code className="checksum">{snapshot.checksum}</code></td>
                <td>{snapshot.confirmed_at}</td>
                <td className="caliber-cell">{snapshot.remark}</td>
                <td>
                  <button className="link" type="button" disabled={running} onClick={() => void runReplay(snapshot.snapshot_id)}>
                    按此快照重演
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      {replay && (
        <section className="replay-result">
          <header className="branch-title">
            <h5>重演结果（{replay.snapshot_id}）</h5>
            <span className="badge badge-ok">确定性重演：{replay.deterministic ? '通过' : '失败'}</span>
            <code className="checksum">{replay.replay_checksum}</code>
          </header>
          <p className="drawer-note">{replay.notice}</p>
          <table className="data-table compact">
            <thead>
              <tr>
                <th>行号</th>
                <th>样本</th>
                <th>输出指纹</th>
                <th>历史采集结果</th>
                <th>历史是否被覆写</th>
              </tr>
            </thead>
            <tbody>
              {replay.items.map((item) => (
                <tr key={item.sample_id}>
                  <td>#{item.line_no}</td>
                  <td>{item.sample_id}</td>
                  <td><code className="checksum">{item.checksum}</code></td>
                  <td>
                    {item.frozen_history === null ? (
                      <span className="badge badge-unknown">无历史结果</span>
                    ) : item.history_match ? (
                      <span className="badge badge-ok">与重演输出一致</span>
                    ) : (
                      <span className="badge badge-warn">与重演输出存在差异（历史保持冻结）</span>
                    )}
                  </td>
                  <td>
                    <span className={`badge ${item.history_overwritten ? 'badge-blocked' : 'badge-ok'}`}>
                      {item.history_overwritten ? '已覆写（异常）' : '未覆写'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  )
}
