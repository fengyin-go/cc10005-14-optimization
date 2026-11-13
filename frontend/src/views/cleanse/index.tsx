import { useCallback, useEffect, useMemo, useState } from 'react'

import { request } from '@/api/client'
import ReviewWorkbench from './review/ReviewWorkbench'

const ENDPOINT = '/api/cleanse'
const columns = [
  "规则编号",
  "目标字段",
  "空值替换",
  "格式规范化",
  "异常值剔除",
  "去重键列",
  "规则版本",
  "生效日期"
]
const actions = [
  "提交校验",
  "启用规则",
  "停用规则"
]
const stats = [
  {
    "label": "清洗规则总数",
    "value": 0
  },
  {
    "label": "已启用规则",
    "value": 0
  },
  {
    "label": "待校验规则",
    "value": 0
  }
]

type Row = Record<string, string | number | null>

function RuleListTab() {
  const [rows, setRows] = useState<Row[]>([])
  const [total, setTotal] = useState(0)
  const [errorMessage, setErrorMessage] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const filterFields = useMemo(() => columns.slice(0, 3), [])

  const reload = useCallback(async () => {
    setErrorMessage('')
    const query = new URLSearchParams(filters).toString()
    try {
      const response = await request(`${ENDPOINT}?${query}`)
      if (!response.ok) {
        throw new Error('清洗规则列表读取失败')
      }
      const payload = await response.json()
      setRows(payload.items ?? [])
      setTotal(payload.total ?? 0)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '数据清洗列表读取失败')
    }
  }, [filters])

  useEffect(() => {
    void reload()
  }, [reload])

  async function runAction(action: string, row: Row) {
    setErrorMessage('')
    try {
      const response = await request(`${ENDPOINT}/${row.id}/actions`, {
        method: 'POST',
        body: JSON.stringify({ action }),
      })
      if (!response.ok) {
        throw new Error('数据清洗动作未生效，请稍后重试')
      }
      await reload()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '数据清洗操作失败')
    }
  }

  return (
    <>
      <div className="stat-row">
        {stats.map((item) => (
          <article key={item.label} className="stat-card">
            <span className="stat-label">{item.label}</span>
            <strong className="stat-value">{item.value}</strong>
          </article>
        ))}
      </div>

      <form className="filter-bar" onSubmit={(event) => { event.preventDefault(); void reload() }}>
        {filterFields.map((field) => (
          <label key={field} className="filter-item">
            <span>{field}</span>
            <input
              value={filters[field] ?? ''}
              placeholder={`按${field}检索`}
              onChange={(event) => setFilters((prev) => ({ ...prev, [field]: event.target.value }))}
            />
          </label>
        ))}
        <button className="btn" type="submit">查询</button>
        <button className="btn ghost" type="button" onClick={() => setFilters({})}>重置条件</button>
      </form>

      <table className="data-table">
        <thead>
          <tr>
            {columns.map((column) => <th key={column}>{column}</th>)}
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={String(row.id)}>
              {columns.map((column) => <td key={column}>{row[column] ?? '—'}</td>)}
              <td className="row-actions">
                {actions.map((action) => (
                  <button key={action} className="link" type="button" onClick={() => void runAction(action, row)}>
                    {action}
                  </button>
                ))}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={columns.length + 1}>暂无数据清洗数据，可先登记清洗规则</td>
            </tr>
          )}
        </tbody>
      </table>

      <footer className="page-foot">
        <span>共 {total} 条数据清洗记录</span>
        {errorMessage && <span className="error-text">{errorMessage}</span>}
      </footer>
    </>
  )
}

export default function CleanseView() {
  const [tab, setTab] = useState<'review' | 'rules'>('review')
  return (
    <section className="page" data-module="cleanse">
      <header className="page-head">
        <div>
          <h2>数据清洗管理</h2>
          <p className="page-desc">维护数据清洗规则的输入、执行约束与结果记录，并在候选版本对照台中完成预演、逐条核对与快照确认。</p>
        </div>
        <div className="page-actions">
          <div className="tab-switch" role="tablist">
            <button
              role="tab"
              className={`tab-btn ${tab === 'review' ? 'active' : ''}`}
              type="button"
              onClick={() => setTab('review')}
            >
              候选版本对照台
            </button>
            <button
              role="tab"
              className={`tab-btn ${tab === 'rules' ? 'active' : ''}`}
              type="button"
              onClick={() => setTab('rules')}
            >
              清洗规则清单
            </button>
          </div>
          <button className="btn" type="button" onClick={() => window.open(`${ENDPOINT}/export`, '_blank')}>
            导出数据清洗清单
          </button>
        </div>
      </header>

      {tab === 'review' ? <ReviewWorkbench /> : <RuleListTab />}
    </section>
  )
}
