"""清洗版本对照台接口。

路由统一挂在 /api/cleanse/review 下，与既有清洗规则 CRUD（/api/cleanse）隔离：
- 样本批量载入、分组对照、逐段差异明细；
- 候选规则修改（只重算受影响分支）、同字段冲突裁决、候选确认生成快照；
- 快照查询与重演对账，未确认试验分支不会出现在作业可选快照里。
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.services.cleanse_review.service import review_service

router = APIRouter(prefix="/api/cleanse/review", tags=["数据清洗-版本对照"])


class SampleIdPayload(BaseModel):
    sample_ids: list[str] = Field(default_factory=list)


class RuleUpdatePayload(BaseModel):
    values: dict[str, Any] = Field(default_factory=dict)


class ConflictPayload(BaseModel):
    field: str
    ordered_rule_codes: list[str]
    policy: str  # first_wins / last_wins


class ConfirmPayload(BaseModel):
    remark: str | None = None


class ReplayPayload(BaseModel):
    snapshot_id: str
    sample_ids: list[str] = Field(default_factory=list)


@router.get("/samples")
def load_samples() -> dict[str, Any]:
    """批量载入带行号样本；缺版本种子样例带 source_unknown 标识。"""
    return review_service.load_samples()


@router.get("/overview")
def review_overview() -> dict[str, Any]:
    """对照台总览：差异字段分布、挂起样本、未裁决冲突与当前快照。"""
    return review_service.overview()


@router.get("/rules/{branch}")
def list_branch_rules(branch: str) -> dict[str, Any]:
    """读取启用版/候选版规则及同字段冲突清单。"""
    return review_service.list_rules(branch)


@router.put("/rules/candidate/{rule_code}")
def update_candidate_rule(rule_code: str, payload: RuleUpdatePayload) -> dict[str, Any]:
    """修改候选规则；后端只重算受影响样本分支，未命中样本保留原预演结果。"""
    return review_service.update_candidate_rule(rule_code, payload.values)


@router.post("/conflicts/resolve")
def resolve_conflicts(payload: ConflictPayload) -> dict[str, Any]:
    """确定同字段规则的先后顺序与冲突裁决后，重算受影响字段的样本分支。"""
    return review_service.resolve_conflicts(payload.model_dump())


@router.post("/compare")
def compare(payload: SampleIdPayload) -> dict[str, Any]:
    """对勾选样本整组比较启用版与候选版输出，返回差异单元格与口径说明。"""
    return review_service.compare(payload.sample_ids)


@router.get("/samples/{sample_id}/detail")
def sample_detail(sample_id: str) -> dict[str, Any]:
    """逐条核对：展开空值替换/格式规范化/异常值剔除/去重键各段输入输出。"""
    return review_service.sample_detail(sample_id)


@router.post("/confirm")
def confirm_candidate(payload: ConfirmPayload) -> dict[str, Any]:
    """一次提交候选确认；冲突未裁决或预演挂起时拦截，成功则产出不可变快照。"""
    return review_service.confirm_candidate({"remark": payload.remark})


@router.get("/snapshots")
def list_snapshots() -> dict[str, Any]:
    """清洗快照清单；selectable_for_jobs 即字段映射/作业允许引用的快照。"""
    return review_service.list_snapshots()


@router.get("/job-context")
def job_context() -> dict[str, Any]:
    """字段映射/作业引用上下文：只暴露已确认快照，试验分支不可选。"""
    return review_service.job_context()


@router.get("/snapshots/{snapshot_id}")
def get_snapshot(snapshot_id: str) -> dict[str, Any]:
    """读取单个快照全文（含规则与裁决口径），用于审计与重演。"""
    return review_service.get_snapshot(snapshot_id)


@router.post("/replay")
def replay(payload: ReplayPayload) -> dict[str, Any]:
    """基于已确认快照在输入副本上重演，校验确定性差异指纹且不覆写历史结果。"""
    return review_service.replay(payload.model_dump())
