"""清洗引擎：四段式（空值替换 → 格式规范化 → 异常值剔除 → 去重键）纯函数实现。

所有函数都不直接读写仓库状态，只接受普通 dict / list，保证：
1. 预演副本与真实输入隔离——调用方传入样本深拷贝，引擎无法回写原始样本；
2. 同样输入 + 同样规则快照重演结果确定，差异指纹（checksum）可复算；
3. 规则改动后可按段位只重算受影响的样本分支。
"""
from __future__ import annotations

import copy
import hashlib
import json
from typing import Any

# 四个清洗段位的固定执行顺序与中文标签
STAGE_ORDER = ["null_replace", "normalize", "outlier", "dedup"]
STAGE_LABELS: dict[str, str] = {
    "null_replace": "空值替换",
    "normalize": "格式规范化",
    "outlier": "异常值剔除",
    "dedup": "去重键",
}

NULL_TOKENS = {"", "null", "none", "n/a", "na", "nan", "-", "--", "无"}


def canonical_json(payload: Any) -> str:
    """对任意可 JSON 化的数据做稳定序列化，供差异指纹使用。"""
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def checksum(payload: Any) -> str:
    """对结果计算确定性指纹；相同输入与规则必然得到相同指纹。"""
    digest = hashlib.sha256(canonical_json(payload).encode("utf-8")).hexdigest()
    return digest[:16]


def is_blank(value: Any) -> bool:
    if value is None:
        return True
    return str(value).strip().lower() in NULL_TOKENS


def _as_float(value: Any) -> float | None:
    try:
        return float(str(value).replace(",", "").strip())
    except (TypeError, ValueError):
        return None


def apply_null_replace(record: dict[str, Any], rule: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """空值替换段：命中空值标记的单元格写入默认值，逐格记录输入/输出。"""
    result = copy.deepcopy(record)
    field = rule["target_field"]
    replacement = rule.get("null_replacement")
    changes: list[dict[str, Any]] = []
    if field in result and is_blank(result.get(field)):
        before = result.get(field)
        result[field] = replacement
        changes.append({"field": field, "before": before, "after": replacement, "reason": "命中空值标记"})
    return result, changes


def apply_normalize(record: dict[str, Any], rule: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """格式规范化段：支持 trim / upper / lower / digits / fullwidth_halfwidth 几种可组合口径。"""
    result = copy.deepcopy(record)
    field = rule["target_field"]
    changes: list[dict[str, Any]] = []
    if field not in result or is_blank(result.get(field)):
        return result, changes
    original = str(result[field])
    text = original
    for operation in rule.get("normalize_ops", []):
        if operation == "trim":
            text = text.strip()
        elif operation == "upper":
            text = text.upper()
        elif operation == "lower":
            text = text.lower()
        elif operation == "digits":
            text = "".join(ch for ch in text if ch.isdigit())
        elif operation == "halfwidth":
            text = "".join(chr(ord(ch) - 0xFEE0) if 0xFF01 <= ord(ch) <= 0xFF5E else ch for ch in text)
    if text != original:
        result[field] = text
        changes.append({
            "field": field,
            "before": original,
            "after": text,
            "reason": f"规范化口径：{'、'.join(rule.get('normalize_ops', [])) or '无'}",
        })
    return result, changes


def apply_outlier(record: dict[str, Any], rule: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]], bool]:
    """异常值剔除段：数值超出阈值区间的单元格剔除（置空），并标记该样本是否被剔除。"""
    result = copy.deepcopy(record)
    field = rule["target_field"]
    changes: list[dict[str, Any]] = []
    dropped = False
    if field not in result or is_blank(result.get(field)):
        return result, changes, dropped
    bounds = rule.get("outlier_bounds") or {}
    numeric = _as_float(result.get(field))
    if numeric is None:
        return result, changes, dropped
    minimum = bounds.get("min")
    maximum = bounds.get("max")
    violation: str | None = None
    if minimum is not None and numeric < float(minimum):
        violation = f"低于下限 {minimum}"
    elif maximum is not None and numeric > float(maximum):
        violation = f"高于上限 {maximum}"
    if violation:
        before = result[field]
        result[field] = None
        dropped = True
        changes.append({"field": field, "before": before, "after": None, "reason": violation})
    return result, changes, dropped


def build_dedup_key(record: dict[str, Any], rule: dict[str, Any]) -> str | None:
    """按去重键列拼接样本键；任一键列为空则不出键（不参与去重判定）。"""
    columns = rule.get("dedup_columns") or []
    if not columns:
        return None
    parts: list[str] = []
    for column in columns:
        value = record.get(column)
        if is_blank(value):
            return None
        parts.append(str(value).strip())
    return "|".join(parts)


def run_pipeline(
    sample: dict[str, Any],
    rules: list[dict[str, Any]],
    *,
    as_of_date: str | None = None,
    field_pipeline: dict[str, list[str]] | None = None,
    conflict_policy: dict[str, str] | None = None,
) -> dict[str, Any]:
    """对单个样本跑完整四段清洗，返回每段输入/输出轨迹与最终结果。

    入参 sample 会被深拷贝，原始对象不会被修改（预演隔离的底层保证）。
    as_of_date 用于按规则生效日期选择口径；field_pipeline / conflict_policy
    决定同字段多条规则的先后顺序与冲突裁决。
    """
    field_pipeline = field_pipeline or {}
    conflict_policy = conflict_policy or {}
    working = copy.deepcopy(sample)
    source_data = working.get("raw", {})
    current = copy.deepcopy(source_data)
    stage_traces: list[dict[str, Any]] = []
    dropped_outliers: list[dict[str, Any]] = []

    # 按生效日期过滤：样本日期早于规则生效日期时，该规则不参与本次清洗
    applicable: list[dict[str, Any]] = []
    skipped_by_date: list[dict[str, str]] = []
    sample_date = sample.get("sample_date")
    for rule in rules:
        effective = rule.get("effective_date")
        if effective and sample_date and str(sample_date) < str(effective):
            skipped_by_date.append({"rule_code": rule["rule_code"], "effective_date": effective})
            continue
        applicable.append(rule)

    def rules_for(stage: str, field: str) -> list[dict[str, Any]]:
        stage_rules = [rule for rule in applicable if rule.get("target_field") == field and rule.get("stage") == stage]
        ordered_codes = field_pipeline.get(field)
        if ordered_codes:
            index = {code: i for i, code in enumerate(ordered_codes)}
            stage_rules.sort(key=lambda item: index.get(item["rule_code"], len(index)))
        return stage_rules

    touched_fields = sorted({rule["target_field"] for rule in applicable})

    for stage in STAGE_ORDER:
        stage_input = copy.deepcopy(current)
        stage_changes: list[dict[str, Any]] = []
        if stage == "dedup":
            # 去重是批次级判定，这里只产出键；批次去重标记由 run_batch 回填
            dedup_rules = [rule for rule in applicable if rule.get("stage") == "dedup"]
            keys_seen: dict[str, str | None] = {}
            for rule in dedup_rules:
                keys_seen[rule["rule_code"]] = build_dedup_key(current, rule)
            stage_output = copy.deepcopy(current)
            stage_traces.append({
                "stage": stage,
                "label": STAGE_LABELS[stage],
                "input": stage_input,
                "output": stage_output,
                "changes": stage_changes,
                "dedup_keys": keys_seen,
            })
            continue

        for field in touched_fields:
            stage_rules = rules_for(stage, field)
            if len(stage_rules) > 1 and conflict_policy.get(field) not in {"first_wins", "last_wins"}:
                # 未裁决的同字段冲突：仅当该段规则在这条样本上确实会执行时才挂起，
                # 避免对根本不会触发该段的样本误报 blocked。
                relevant = True
                if stage == "null_replace":
                    relevant = field in current and is_blank(current.get(field))
                elif stage == "normalize":
                    relevant = field in current and not is_blank(current.get(field))
                elif stage == "outlier":
                    relevant = field in current and not is_blank(current.get(field)) and _as_float(current.get(field)) is not None
                if relevant:
                    stage_changes.append({
                        "field": field,
                        "before": current.get(field),
                        "after": current.get(field),
                        "reason": f"同字段 {len(stage_rules)} 条规则未裁决，已挂起",
                        "blocked": True,
                        "rule_codes": [rule["rule_code"] for rule in stage_rules],
                    })
                continue
            for index, rule in enumerate(stage_rules):
                if stage == "null_replace":
                    current, changes = apply_null_replace(current, rule)
                elif stage == "normalize":
                    current, changes = apply_normalize(current, rule)
                else:
                    current, changes, dropped = apply_outlier(current, rule)
                    if dropped:
                        dropped_outliers.append({"field": field, "rule_code": rule["rule_code"]})
                for change in changes:
                    change["rule_code"] = rule["rule_code"]
                    stage_changes.append(change)
                if len(stage_rules) > 1 and changes and conflict_policy.get(field) == "first_wins" and index == 0:
                    break

        stage_traces.append({
            "stage": stage,
            "label": STAGE_LABELS[stage],
            "input": stage_input,
            "output": copy.deepcopy(current),
            "changes": stage_changes,
        })

    return {
        "sample_id": sample["sample_id"],
        "line_no": sample.get("line_no"),
        "source_version": sample.get("source_version"),
        "source_unknown": sample.get("source_version") in (None, ""),
        "sample_date": sample_date,
        "output": current,
        "stage_traces": stage_traces,
        "skipped_rules": skipped_by_date,
        "dropped_outliers": dropped_outliers,
        "dedup_flag": False,
        "dedup_reason": None,
        "blocked": any(
            change.get("blocked")
            for trace in stage_traces
            for change in trace.get("changes", [])
        ),
    }


def run_batch(
    samples: list[dict[str, Any]],
    rules: list[dict[str, Any]],
    *,
    as_of_date: str | None = None,
    field_pipeline: dict[str, list[str]] | None = None,
    conflict_policy: dict[str, str] | None = None,
) -> list[dict[str, Any]]:
    """批量预演：在单样本轨迹之外补做批次级去重判定。"""
    results = [
        run_pipeline(
            sample,
            rules,
            as_of_date=as_of_date,
            field_pipeline=field_pipeline,
            conflict_policy=conflict_policy,
        )
        for sample in samples
    ]
    seen: dict[str, str] = {}
    for result in results:
        dedup_trace = next(trace for trace in result["stage_traces"] if trace["stage"] == "dedup")
        for rule_code, key in (dedup_trace.get("dedup_keys") or {}).items():
            if not key:
                continue
            if key in seen:
                result["dedup_flag"] = True
                result["dedup_reason"] = f"去重键 {key} 与行 {seen[key]} 重复（{rule_code}）"
                dedup_trace["changes"].append({
                    "field": "dedup_key",
                    "before": key,
                    "after": None,
                    "reason": result["dedup_reason"],
                    "rule_code": rule_code,
                })
            else:
                seen[key] = f"#{result['line_no']}"
    return results


def diff_cells(baseline_output: dict[str, Any], candidate_output: dict[str, Any]) -> list[dict[str, Any]]:
    """逐字段比对启用版与候选版输出，产出差异单元格清单。"""
    fields = sorted(set(baseline_output) | set(candidate_output))
    cells: list[dict[str, Any]] = []
    for field in fields:
        before = baseline_output.get(field)
        after = candidate_output.get(field)
        if before != after:
            cells.append({"field": field, "enabled": before, "candidate": after})
    return cells
