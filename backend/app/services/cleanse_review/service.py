"""候选版本对照台状态服务。

职责边界：
- 样本、规则、分支预演结果都保存在内存工作台里，预演只操作样本副本；
- 候选规则改动后只重算受影响样本分支（去重段除外，因其为批次级判定）；
- 同字段多规则必须先确定先后顺序与冲突裁决，才允许确认候选版；
- 确认动作产出不可变清洗快照，字段映射/作业只能选用已确认快照；
- 重演基于快照 + 输入副本做纯函数复算，历史采集结果冻结、不被候选版覆写。
"""
from __future__ import annotations

import copy
from typing import Any

from app.services.cleanse_review import review_seed
from app.services.cleanse_review.engine import (
    STAGE_LABELS,
    STAGE_ORDER,
    checksum,
    diff_cells,
    run_batch,
    run_pipeline,
)


class CleanseReviewService:
    def __init__(self) -> None:
        # 样本是工作台的“真实输入”，预演永远基于深拷贝，不直接改它
        self._samples: list[dict[str, Any]] = copy.deepcopy(review_seed.REVIEW_SAMPLES)
        self._enabled_rules: list[dict[str, Any]] = copy.deepcopy(review_seed.ENABLED_RULES)
        self._candidate_rules: list[dict[str, Any]] = copy.deepcopy(review_seed.CANDIDATE_RULES)

        # 同字段规则的先后顺序与冲突裁决；未配置时同字段冲突会挂起预演
        self._field_pipeline: dict[str, list[str]] = {}
        self._conflict_policy: dict[str, str] = {}

        # 已确认的不可变清洗快照；字段映射模块只能引用这里的快照
        self._snapshots: list[dict[str, Any]] = [
            {
                "snapshot_id": "SNAP-v3-0001",
                "version": "v3",
                "status": "active",
                "rule_count": len(self._enabled_rules),
                "checksum": checksum(self._enabled_rules),
                "field_pipeline": {},
                "conflict_policy": {},
                "rules": copy.deepcopy(self._enabled_rules),
                "confirmed_at": "2026-09-01T09:00:00",
                "remark": "当前启用版清洗快照，作业与字段映射默认引用",
            }
        ]
        # 字段映射/作业当前引用的快照；未确认的候选试验分支永远拿不到这个引用
        self._mapping_snapshot_id: str = "SNAP-v3-0001"

        # 每个分支独立缓存样本级预演结果，规则改动只作废受影响分支
        self._branch_cache: dict[str, dict[str, dict[str, Any]]] = {
            "enabled": {},
            "candidate": {},
        }
        self._rebuild_branch("enabled", dirty_ids=[sample["sample_id"] for sample in self._samples])
        self._rebuild_branch("candidate", dirty_ids=[sample["sample_id"] for sample in self._samples])

    # ------------------------------------------------------------------
    # 内部工具
    # ------------------------------------------------------------------
    def _rules_of(self, branch: str) -> list[dict[str, Any]]:
        return self._enabled_rules if branch == "enabled" else self._candidate_rules

    def _sample_index(self) -> dict[str, dict[str, Any]]:
        return {sample["sample_id"]: sample for sample in self._samples}

    def _rebuild_branch(self, branch: str, *, dirty_ids: list[str]) -> list[str]:
        """重算指定分支上受影响的样本分支，未受影响样本保持原结果。

        非去重段规则改动：只重算目标字段命中的样本；去重段规则改动：
        去重是批次级判定，需要全量重算并回填去重标记。
        """
        rules = self._rules_of(branch)
        cache = self._branch_cache[branch]
        dirty_set = set(dirty_ids)
        any_dedup_rule = any(rule.get("stage") == "dedup" for rule in rules if rule["rule_code"] in dirty_set)

        if any_dedup_rule or not cache:
            results = run_batch(
                copy.deepcopy(self._samples),
                copy.deepcopy(rules),
                field_pipeline=copy.deepcopy(self._field_pipeline),
                conflict_policy=copy.deepcopy(self._conflict_policy),
            )
            cache.clear()
            for result in results:
                cache[result["sample_id"]] = result
            return sorted(dirty_set)

        # 选择性重算：仅脏样本重跑单样本流水线，随后全批次回填去重标记
        index = self._sample_index()
        for sample_id in dirty_ids:
            sample = index.get(sample_id)
            if sample is None:
                continue
            cache[sample_id] = run_pipeline(
                copy.deepcopy(sample),
                copy.deepcopy(rules),
                field_pipeline=copy.deepcopy(self._field_pipeline),
                conflict_policy=copy.deepcopy(self._conflict_policy),
            )
        self._reapply_dedup(branch)
        return sorted(dirty_set)

    def _reapply_dedup(self, branch: str) -> None:
        """基于当前全部样本输出重新判定批次去重，避免漏标/错标重复行。"""
        cache = self._branch_cache[branch]
        dedup_rules = [rule for rule in self._rules_of(branch) if rule.get("stage") == "dedup"]
        seen: dict[str, str] = {}
        for sample_id in sorted(cache, key=lambda sid: cache[sid].get("line_no", 0)):
            result = cache[sample_id]
            result["dedup_flag"] = False
            result["dedup_reason"] = None
            dedup_trace = next(trace for trace in result["stage_traces"] if trace["stage"] == "dedup")
            dedup_trace["changes"] = []
            keys = dedup_trace.get("dedup_keys") or {}
            for rule in dedup_rules:
                key = keys.get(rule["rule_code"])
                if not key:
                    continue
                if key in seen:
                    result["dedup_flag"] = True
                    result["dedup_reason"] = f"去重键 {key} 与行 {seen[key]} 重复（{rule['rule_code']}）"
                    dedup_trace["changes"].append({
                        "field": "dedup_key",
                        "before": key,
                        "after": None,
                        "reason": result["dedup_reason"],
                        "rule_code": rule["rule_code"],
                    })
                else:
                    seen[key] = f"#{result['line_no']}"

    def _caliber_notes(self, result: dict[str, Any], branch: str) -> list[dict[str, str]]:
        """按样本日期与规则生效日期解释旧数据/新数据分别采用的口径。"""
        notes: list[dict[str, str]] = []
        sample_date = result.get("sample_date") or "未知日期"
        for rule in self._rules_of(branch):
            effective = rule.get("effective_date")
            if not effective:
                continue
            skipped = any(item["rule_code"] == rule["rule_code"] for item in result.get("skipped_rules", []))
            if skipped:
                notes.append({
                    "rule_code": rule["rule_code"],
                    "effective_date": effective,
                    "sample_date": sample_date,
                    "caliber": "old",
                    "text": f"样本日期 {sample_date} 早于规则 {rule['rule_code']} 生效日 {effective}，沿用旧口径（该规则不生效）",
                })
            else:
                notes.append({
                    "rule_code": rule["rule_code"],
                    "effective_date": effective,
                    "sample_date": sample_date,
                    "caliber": "new",
                    "text": f"样本日期 {sample_date} 不早于生效日 {effective}，采用新口径：{rule['rule_name']}",
                })
        return notes

    def _conflicts(self, branch: str) -> list[dict[str, Any]]:
        grouped: dict[tuple[str, str], list[str]] = {}
        for rule in self._rules_of(branch):
            grouped.setdefault((rule["target_field"], rule["stage"]), []).append(rule["rule_code"])
        conflicts: list[dict[str, Any]] = []
        for (field, stage), codes in grouped.items():
            if len(codes) < 2:
                continue
            conflicts.append({
                "field": field,
                "stage": stage,
                "stage_label": STAGE_LABELS[stage],
                "rule_codes": codes,
                "ordered_codes": self._field_pipeline.get(field, []),
                "policy": self._conflict_policy.get(field),
                "resolved": self._conflict_policy.get(field) in {"first_wins", "last_wins"}
                and set(codes).issubset(set(self._field_pipeline.get(field, []))),
            })
        return conflicts

    # ------------------------------------------------------------------
    # 工作台读取接口
    # ------------------------------------------------------------------
    def load_samples(self) -> dict[str, Any]:
        """批量载入带行号样本；缺版本的样例明确标识未知来源。"""
        items = []
        for sample in sorted(self._samples, key=lambda row: row["line_no"]):
            items.append({
                "sample_id": sample["sample_id"],
                "line_no": sample["line_no"],
                "sample_date": sample.get("sample_date"),
                "source_version": sample.get("source_version"),
                "source_unknown": not sample.get("source_version"),
                "raw": copy.deepcopy(sample.get("raw", {})),
                "has_frozen_history": sample.get("frozen_history") is not None,
            })
        return {"total": len(items), "items": items}

    def list_rules(self, branch: str) -> dict[str, Any]:
        if branch not in {"enabled", "candidate"}:
            return {"ok": False, "message": "分支只能是 enabled 或 candidate"}
        return {
            "branch": branch,
            "version": "v3" if branch == "enabled" else "v4",
            "items": copy.deepcopy(self._rules_of(branch)),
            "conflicts": self._conflicts(branch),
        }

    def overview(self) -> dict[str, Any]:
        enabled_cache = self._branch_cache["enabled"]
        candidate_cache = self._branch_cache["candidate"]
        diff_counts: dict[str, int] = {}
        blocked = 0
        for sample_id, candidate_result in candidate_cache.items():
            baseline = enabled_cache.get(sample_id)
            if baseline is None:
                continue
            cells = diff_cells(baseline["output"], candidate_result["output"])
            for cell in cells:
                diff_counts[cell["field"]] = diff_counts.get(cell["field"], 0) + 1
            if candidate_result.get("blocked"):
                blocked += 1
        return {
            "sample_total": len(self._samples),
            "enabled_rule_total": len(self._enabled_rules),
            "candidate_rule_total": len(self._candidate_rules),
            "diff_field_counts": diff_counts,
            "blocked_samples": blocked,
            "unresolved_conflicts": [item for item in self._conflicts("candidate") if not item["resolved"]],
            "snapshot_total": len(self._snapshots),
            "active_snapshot": next((item["snapshot_id"] for item in self._snapshots if item["status"] == "active"), None),
            "mapping_snapshot_id": self._mapping_snapshot_id,
        }

    # ------------------------------------------------------------------
    # 规则编辑：仅候选分支可改，改动只重算受影响样本
    # ------------------------------------------------------------------
    def update_candidate_rule(self, rule_code: str, values: dict[str, Any]) -> dict[str, Any]:
        target = next((rule for rule in self._candidate_rules if rule["rule_code"] == rule_code), None)
        if target is None:
            return {"ok": False, "message": f"候选规则 {rule_code} 不存在，试验分支无法定位"}
        editable = {
            "null_replacement", "normalize_ops", "outlier_bounds",
            "dedup_columns", "effective_date", "rule_name",
        }
        for key, value in values.items():
            if key in editable:
                target[key] = value
        affected_stage = target["stage"]
        if affected_stage == "dedup":
            dirty_ids = [sample["sample_id"] for sample in self._samples]
        else:
            dirty_ids = [
                sample["sample_id"]
                for sample in self._samples
                if target["target_field"] in sample.get("raw", {})
            ]
        recomputed = self._rebuild_branch("candidate", dirty_ids=dirty_ids)
        return {
            "ok": True,
            "message": f"规则 {rule_code} 已更新，仅重算受影响样本分支 {len(recomputed)} 条",
            "rule": copy.deepcopy(target),
            "affected_stage": affected_stage,
            "recomputed_sample_ids": recomputed,
        }

    # ------------------------------------------------------------------
    # 同字段冲突裁决
    # ------------------------------------------------------------------
    def resolve_conflicts(self, payload: dict[str, Any]) -> dict[str, Any]:
        field = str(payload.get("field") or "").strip()
        ordered_codes = payload.get("ordered_rule_codes") or []
        policy = str(payload.get("policy") or "").strip()
        if policy not in {"first_wins", "last_wins"}:
            return {"ok": False, "message": "冲突裁决必须是 first_wins（先者生效）或 last_wins（后者覆盖）"}
        conflict = next(
            (item for item in self._conflicts("candidate") if item["field"] == field),
            None,
        )
        if conflict is None:
            return {"ok": False, "message": f"字段 {field} 不存在同字段多规则冲突，无需裁决"}
        if sorted(ordered_codes) != sorted(conflict["rule_codes"]):
            return {
                "ok": False,
                "message": f"先后顺序必须完整覆盖规则 { '、'.join(conflict['rule_codes']) }",
            }
        self._field_pipeline[field] = list(ordered_codes)
        self._conflict_policy[field] = policy
        # 裁决改变执行顺序，受影响字段对应的样本分支需要重算
        dirty_ids = [
            sample["sample_id"]
            for sample in self._samples
            if field in sample.get("raw", {})
        ]
        recomputed = self._rebuild_branch("candidate", dirty_ids=dirty_ids)
        return {
            "ok": True,
            "message": f"字段 {field} 冲突已裁决（{policy}），重算 {len(recomputed)} 条样本分支",
            "conflicts": self._conflicts("candidate"),
            "recomputed_sample_ids": recomputed,
        }

    # ------------------------------------------------------------------
    # 分组对照与逐条差异
    # ------------------------------------------------------------------
    def compare(self, sample_ids: list[str]) -> dict[str, Any]:
        if not sample_ids:
            return {"ok": False, "message": "请先勾选需要复查的样本条目"}
        enabled_cache = self._branch_cache["enabled"]
        candidate_cache = self._branch_cache["candidate"]
        items: list[dict[str, Any]] = []
        for sample in self._samples:
            if sample["sample_id"] not in sample_ids:
                continue
            baseline = enabled_cache.get(sample["sample_id"])
            candidate = candidate_cache.get(sample["sample_id"])
            if baseline is None or candidate is None:
                continue
            cells = diff_cells(baseline["output"], candidate["output"])
            items.append({
                "sample_id": sample["sample_id"],
                "line_no": sample["line_no"],
                "sample_date": sample.get("sample_date"),
                "source_version": sample.get("source_version"),
                "source_unknown": not sample.get("source_version"),
                "enabled_output": copy.deepcopy(baseline["output"]),
                "candidate_output": copy.deepcopy(candidate["output"]),
                "diff_cells": cells,
                "diff_count": len(cells),
                "candidate_blocked": candidate.get("blocked", False),
                "candidate_dedup_flag": candidate.get("dedup_flag", False),
                "candidate_dedup_reason": candidate.get("dedup_reason"),
                "enabled_dedup_flag": baseline.get("dedup_flag", False),
                "caliber_notes": self._caliber_notes(candidate, "candidate"),
            })
        return {
            "ok": True,
            "selected_total": len(items),
            "diff_total": sum(item["diff_count"] for item in items),
            "items": items,
        }

    def sample_detail(self, sample_id: str) -> dict[str, Any]:
        sample = self._sample_index().get(sample_id)
        if sample is None:
            return {"ok": False, "message": f"样本 {sample_id} 不存在或已移出对照台"}
        baseline = self._branch_cache["enabled"].get(sample_id)
        candidate = self._branch_cache["candidate"].get(sample_id)
        return {
            "ok": True,
            "sample": {
                "sample_id": sample_id,
                "line_no": sample["line_no"],
                "sample_date": sample.get("sample_date"),
                "source_version": sample.get("source_version"),
                "source_unknown": not sample.get("source_version"),
                "raw": copy.deepcopy(sample.get("raw", {})),
                "frozen_history": copy.deepcopy(sample.get("frozen_history")),
            },
            "enabled": {
                "output": copy.deepcopy(baseline["output"]),
                "stage_traces": copy.deepcopy(baseline["stage_traces"]),
                "checksum": checksum(baseline["output"]),
                "caliber_notes": self._caliber_notes(baseline, "enabled"),
            },
            "candidate": {
                "output": copy.deepcopy(candidate["output"]),
                "stage_traces": copy.deepcopy(candidate["stage_traces"]),
                "checksum": checksum(candidate["output"]),
                "blocked": candidate.get("blocked", False),
                "caliber_notes": self._caliber_notes(candidate, "candidate"),
            },
            "diff_cells": diff_cells(baseline["output"], candidate["output"]),
        }

    # ------------------------------------------------------------------
    # 候选确认：生成不可变快照，未确认试验分支不得被作业选中
    # ------------------------------------------------------------------
    def confirm_candidate(self, payload: dict[str, Any]) -> dict[str, Any]:
        remark = str(payload.get("remark") or "").strip()
        unresolved = [item for item in self._conflicts("candidate") if not item["resolved"]]
        if unresolved:
            fields = "、".join(f"{item['field']}（{item['stage_label']}）" for item in unresolved)
            return {
                "ok": False,
                "code": "CONFLICT_PENDING",
                "message": f"以下同字段冲突尚未裁决，不能确认候选版：{fields}",
                "conflicts": unresolved,
            }
        blocked_samples = [
            sample_id
            for sample_id, result in self._branch_cache["candidate"].items()
            if result.get("blocked")
        ]
        if blocked_samples:
            return {
                "ok": False,
                "code": "BRANCH_BLOCKED",
                "message": f"样本 { '、'.join(blocked_samples) } 的候选预演仍被挂起，请先完成冲突裁决",
            }

        confirmed_rules = copy.deepcopy(self._candidate_rules)
        snapshot = {
            "snapshot_id": f"SNAP-v4-{len(self._snapshots) + 1:04d}",
            "version": "v4",
            "status": "active",
            "rule_count": len(confirmed_rules),
            "checksum": checksum({
                "rules": confirmed_rules,
                "field_pipeline": self._field_pipeline,
                "conflict_policy": self._conflict_policy,
            }),
            "field_pipeline": copy.deepcopy(self._field_pipeline),
            "conflict_policy": copy.deepcopy(self._conflict_policy),
            "rules": confirmed_rules,
            "confirmed_at": "2026-11-13T10:00:00",
            "remark": remark or "候选版 v4 对照确认后生成",
        }
        # 旧快照转为历史引用，不再作为作业默认选择
        for previous in self._snapshots:
            if previous["status"] == "active":
                previous["status"] = "archived"
        self._snapshots.append(snapshot)
        # 字段映射模块切换到这次确认后的清洗快照；确认前的候选试验分支从未被引用
        self._mapping_snapshot_id = snapshot["snapshot_id"]

        # 确认后候选规则晋升为新的启用基线；试验分支重置为该基线的副本
        self._enabled_rules = copy.deepcopy(confirmed_rules)
        self._candidate_rules = copy.deepcopy(confirmed_rules)
        for rule in self._candidate_rules:
            rule["branch"] = "candidate"
        for rule in self._enabled_rules:
            rule["branch"] = "enabled"
        self._rebuild_branch("enabled", dirty_ids=[sample["sample_id"] for sample in self._samples])
        self._rebuild_branch("candidate", dirty_ids=[sample["sample_id"] for sample in self._samples])

        # 历史采集结果保持冻结：确认动作不回写任何样本的 frozen_history
        return {
            "ok": True,
            "message": f"候选版已确认并生成清洗快照 {snapshot['snapshot_id']}，字段映射与作业可引用该快照",
            "snapshot": snapshot,
            "mapping_snapshot_id": self._mapping_snapshot_id,
            "frozen_history_rewritten": False,
        }

    def list_snapshots(self) -> dict[str, Any]:
        return {
            "items": [
                {key: value for key, value in snapshot.items() if key != "rules"}
                for snapshot in self._snapshots
            ],
            # 字段映射/作业可选项：只有已确认快照会出现在这里，试验分支不可选
            "selectable_for_jobs": [
                snapshot["snapshot_id"]
                for snapshot in self._snapshots
                if snapshot["status"] == "active"
            ],
        }

    def job_context(self) -> dict[str, Any]:
        """字段映射/作业引用上下文：当前钉住的快照与允许选择的快照清单。

        候选试验分支没有 snapshot_id，不会出现在 selectable 里，
        因此未确认的规则分支在作业配置侧根本无法被选中。
        """
        selectable = [
            snapshot["snapshot_id"]
            for snapshot in self._snapshots
            if snapshot["status"] == "active"
        ]
        pinned = self._mapping_snapshot_id
        return {
            "mapping_module": "extractor",
            "pinned_snapshot_id": pinned,
            "pinned_exists": any(item["snapshot_id"] == pinned for item in self._snapshots),
            "selectable_snapshot_ids": selectable,
            "trial_branch_selectable": False,
            "note": "字段映射使用最近一次确认后的清洗快照；未确认的候选试验分支不在可选列表中",
        }

    def get_snapshot(self, snapshot_id: str) -> dict[str, Any]:
        snapshot = next((item for item in self._snapshots if item["snapshot_id"] == snapshot_id), None)
        if snapshot is None:
            return {"ok": False, "message": f"快照 {snapshot_id} 不存在；未确认的试验分支没有快照编号"}
        return {"ok": True, "snapshot": copy.deepcopy(snapshot)}

    # ------------------------------------------------------------------
    # 重演对账：同输入 + 同快照必须得到同差异；历史结果不被覆写
    # ------------------------------------------------------------------
    def replay(self, payload: dict[str, Any]) -> dict[str, Any]:
        snapshot_id = str(payload.get("snapshot_id") or "").strip()
        sample_ids = payload.get("sample_ids") or []
        snapshot = next((item for item in self._snapshots if item["snapshot_id"] == snapshot_id), None)
        if snapshot is None:
            return {
                "ok": False,
                "message": f"快照 {snapshot_id} 不存在，未确认的试验分支禁止重演",
            }
        targets = [
            sample for sample in self._samples
            if not sample_ids or sample["sample_id"] in sample_ids
        ]
        if sample_ids and len(targets) != len(set(sample_ids)):
            return {"ok": False, "message": "重演样本中包含对照台不存在的 sample_id"}

        # 关键：输入与快照规则都取副本，重演过程零回写
        replay_results = run_batch(
            copy.deepcopy(targets),
            copy.deepcopy(snapshot["rules"]),
            field_pipeline=copy.deepcopy(snapshot["field_pipeline"]),
            conflict_policy=copy.deepcopy(snapshot["conflict_policy"]),
        )
        items = []
        for result in replay_results:
            sample = next(item for item in targets if item["sample_id"] == result["sample_id"])
            items.append({
                "sample_id": result["sample_id"],
                "line_no": result["line_no"],
                "output": copy.deepcopy(result["output"]),
                "checksum": checksum(result["output"]),
                "frozen_history": copy.deepcopy(sample.get("frozen_history")),
                "history_overwritten": False,
                "history_match": (
                    sample.get("frozen_history") is not None
                    and checksum(sample["frozen_history"]) == checksum(result["output"])
                ),
            })
        return {
            "ok": True,
            "snapshot_id": snapshot_id,
            "snapshot_checksum": snapshot["checksum"],
            "replay_checksum": checksum([item["output"] for item in items]),
            "deterministic": True,
            "items": items,
            "notice": "重演在输入副本上执行；同样输入与同样快照再次重演会得到相同差异指纹，历史采集结果保持冻结",
        }


review_service = CleanseReviewService()
