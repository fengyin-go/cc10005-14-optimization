"""清洗对照台示例数据：带行号的样本、启用版/候选版规则、字段裁决与历史采集结果。

样本里刻意保留：
- 空值、异常值、重复键、半角全角混排等脏数据，方便各清洗段位都有可核对的差异；
- 样本日期跨越规则生效日期的记录，用于解释旧数据/新数据口径；
- source_version 缺省的种子样例，前端必须标识「未知来源」，禁止冒认启用版；
- frozen_history 模拟已经落库的历史采集结果，候选版确认不得覆写它。
"""
from __future__ import annotations

from typing import Any

# 带行号的批量样本（raw 为真实输入，预演只在其副本上进行）
REVIEW_SAMPLES: list[dict[str, Any]] = [
    {
        "sample_id": "S-001",
        "line_no": 1,
        "source_version": "v3",
        "sample_date": "2026-11-01",
        "raw": {"商品名称": " 无线蓝牙耳机 ", "价格": "199.00", "联系电话": "１３８００００１１１１", "城市": "杭州"},
        "frozen_history": {"商品名称": " 无线蓝牙耳机 ", "价格": "199.00", "联系电话": "13800001111", "城市": "杭州"},
    },
    {
        "sample_id": "S-002",
        "line_no": 2,
        "source_version": "v3",
        "sample_date": "2026-11-02",
        "raw": {"商品名称": None, "价格": "89.5", "联系电话": "138-0000-2222", "城市": "上海"},
        "frozen_history": {"商品名称": "未知商品", "价格": "89.5", "联系电话": "13800002222", "城市": "上海"},
    },
    {
        "sample_id": "S-003",
        "line_no": 3,
        "source_version": "v3",
        "sample_date": "2026-11-02",
        "raw": {"商品名称": "智能手表", "价格": "99999", "联系电话": "13800003333", "城市": "广州"},
        "frozen_history": {"商品名称": "智能手表", "价格": "99999", "联系电话": "13800003333", "城市": "广州"},
    },
    {
        "sample_id": "S-004",
        "line_no": 4,
        "source_version": "v3",
        "sample_date": "2026-11-03",
        "raw": {"商品名称": "机械键盘", "价格": "259", "联系电话": "13800004444", "城市": "深圳"},
        "frozen_history": {"商品名称": "机械键盘", "价格": "259", "联系电话": "13800004444", "城市": "深圳"},
    },
    {
        "sample_id": "S-005",
        "line_no": 5,
        "source_version": "v3",
        "sample_date": "2026-11-03",
        "raw": {"商品名称": "机械键盘", "价格": "259", "联系电话": "13800005555", "城市": "深圳"},
        "frozen_history": {"商品名称": "机械键盘", "价格": "259", "联系电话": "13800005555", "城市": "深圳"},
    },
    {
        "sample_id": "S-006",
        "line_no": 6,
        # 故意缺版本：未知来源，禁止自动冒认启用版
        "source_version": None,
        "sample_date": "2026-11-04",
        "raw": {"商品名称": "", "价格": "45", "联系电话": "13800006666", "城市": None},
        "frozen_history": None,
    },
    {
        "sample_id": "S-007",
        "line_no": 7,
        "source_version": "v3",
        # 早于候选规则生效日期：旧数据沿用旧口径
        "sample_date": "2026-08-15",
        "raw": {"商品名称": "老款音箱", "价格": "320", "联系电话": "138 0000 7777", "城市": "北京"},
        "frozen_history": {"商品名称": "老款音箱", "价格": "320", "联系电话": "138 0000 7777", "城市": "北京"},
    },
    {
        "sample_id": "S-008",
        "line_no": 8,
        "source_version": "v3",
        "sample_date": "2026-11-05",
        "raw": {"商品名称": "usb-c 数据线（加长款）", "价格": "29.9", "联系_phone": "13800008888", "城市": "成都"},
        "frozen_history": {"商品名称": "usb-c 数据线（加长款）", "价格": "29.9", "联系电话": "13800008888", "城市": "成都"},
    },
    {
        "sample_id": "S-009",
        "line_no": 9,
        "source_version": "v3",
        "sample_date": "2026-11-06",
        # 价格 12800：启用版上限 50000 保留，候选版收紧到 10000 后剔除，制造可核对差异
        "raw": {"商品名称": "高端投影仪", "价格": "12800", "联系电话": "13800009999", "城市": "杭州"},
        "frozen_history": {"商品名称": "高端投影仪", "价格": "12800", "联系电话": "13800009999", "城市": "杭州"},
    },
]

# 启用版（v3）规则集：当前作业实际使用的清洗口径
ENABLED_RULES: list[dict[str, Any]] = [
    {
        "rule_code": "R1",
        "rule_name": "商品名称空值兜底",
        "branch": "enabled",
        "version": "v3",
        "stage": "null_replace",
        "target_field": "商品名称",
        "null_replacement": "未知商品",
        "normalize_ops": [],
        "outlier_bounds": None,
        "dedup_columns": [],
        "effective_date": "2026-09-01",
    },
    {
        "rule_code": "R2",
        "rule_name": "商品名称去空格",
        "branch": "enabled",
        "version": "v3",
        "stage": "normalize",
        "target_field": "商品名称",
        "null_replacement": None,
        "normalize_ops": ["trim"],
        "outlier_bounds": None,
        "dedup_columns": [],
        "effective_date": "2026-09-01",
    },
    {
        "rule_code": "R3",
        "rule_name": "价格异常区间剔除",
        "branch": "enabled",
        "version": "v3",
        "stage": "outlier",
        "target_field": "价格",
        "null_replacement": None,
        "normalize_ops": [],
        "outlier_bounds": {"min": 0, "max": 50000},
        "dedup_columns": [],
        "effective_date": "2026-09-01",
    },
    {
        "rule_code": "R4",
        "rule_name": "联系电话数字规整",
        "branch": "enabled",
        "version": "v3",
        "stage": "normalize",
        "target_field": "联系电话",
        "null_replacement": None,
        "normalize_ops": ["digits"],
        "outlier_bounds": None,
        "dedup_columns": [],
        "effective_date": "2026-09-01",
    },
    {
        "rule_code": "R5",
        "rule_name": "商品维度去重",
        "branch": "enabled",
        "version": "v3",
        "stage": "dedup",
        "target_field": "商品名称",
        "null_replacement": None,
        "normalize_ops": [],
        "outlier_bounds": None,
        "dedup_columns": ["商品名称", "城市"],
        "effective_date": "2026-09-01",
    },
]

# 候选版（v4）规则集：试验分支，未确认前作业不可选
CANDIDATE_RULES: list[dict[str, Any]] = [
    {
        "rule_code": "R1",
        "rule_name": "商品名称空值兜底",
        "branch": "candidate",
        "version": "v4",
        "stage": "null_replace",
        "target_field": "商品名称",
        # 候选调整：兜底值更明确
        "null_replacement": "待补录商品",
        "normalize_ops": [],
        "outlier_bounds": None,
        "dedup_columns": [],
        "effective_date": "2026-09-01",
    },
    {
        "rule_code": "R2",
        "rule_name": "商品名称大小写与空格规范",
        "branch": "candidate",
        "version": "v4",
        "stage": "normalize",
        "target_field": "商品名称",
        "null_replacement": None,
        # 候选调整：trim 之外再统一大写
        "normalize_ops": ["trim", "upper"],
        "outlier_bounds": None,
        "dedup_columns": [],
        "effective_date": "2026-09-01",
    },
    {
        "rule_code": "R3",
        "rule_name": "价格异常区间剔除",
        "branch": "candidate",
        "version": "v4",
        "stage": "outlier",
        "target_field": "价格",
        "null_replacement": None,
        "normalize_ops": [],
        # 候选调整：收紧上限
        "outlier_bounds": {"min": 0, "max": 10000},
        "dedup_columns": [],
        "effective_date": "2026-09-01",
    },
    {
        "rule_code": "R4",
        "rule_name": "联系电话数字规整",
        "branch": "candidate",
        "version": "v4",
        "stage": "normalize",
        "target_field": "联系电话",
        "null_replacement": None,
        # 候选调整：全角转半角后再抽数字
        "normalize_ops": ["halfwidth", "digits"],
        "outlier_bounds": None,
        "dedup_columns": [],
        "effective_date": "2026-10-01",
    },
    {
        # 候选新增：城市空值兜底，与已有规则写同一字段时进入冲突裁决流程
        "rule_code": "R6",
        "rule_name": "城市空值兜底",
        "branch": "candidate",
        "version": "v4",
        "stage": "null_replace",
        "target_field": "城市",
        "null_replacement": "未知城市",
        "normalize_ops": [],
        "outlier_bounds": None,
        "dedup_columns": [],
        "effective_date": "2026-10-01",
    },
    {
        # 候选新增：与 R1 同写「商品名称」空值替换，未裁决前该字段预演挂起、禁止确认
        "rule_code": "R7",
        "rule_name": "商品名称空值兜底（运营补充口径）",
        "branch": "candidate",
        "version": "v4",
        "stage": "null_replace",
        "target_field": "商品名称",
        "null_replacement": "未命名商品",
        "normalize_ops": [],
        "outlier_bounds": None,
        "dedup_columns": [],
        "effective_date": "2026-10-01",
    },
    {
        "rule_code": "R5",
        "rule_name": "商品维度去重",
        "branch": "candidate",
        "version": "v4",
        "stage": "dedup",
        "target_field": "商品名称",
        "null_replacement": None,
        "normalize_ops": [],
        "outlier_bounds": None,
        "dedup_columns": ["商品名称", "城市"],
        "effective_date": "2026-09-01",
    },
]
