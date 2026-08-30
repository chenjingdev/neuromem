from __future__ import annotations

import datetime as dt
import uuid
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .ids import uuid7
from .slugs import deterministic_slug

Slug = Annotated[str, Field(min_length=1, max_length=128)]


def _uuid7(value: uuid.UUID | None) -> uuid.UUID | None:
    if value is not None and value.version != 7:
        raise ValueError("id must be UUIDv7")
    return value


class OrmModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class WorkspaceCreate(BaseModel):
    id: uuid.UUID | None = None
    slug: Slug | None = None
    name: str = Field(min_length=1, max_length=256)
    metadata: dict[str, Any] = Field(default_factory=dict)

    _validate_id = field_validator("id")(_uuid7)

    @model_validator(mode="after")
    def fill_slug(self) -> WorkspaceCreate:
        self.slug = deterministic_slug(
            self.slug or self.name, fallback_prefix="workspace"
        )
        return self


class WorkspaceView(OrmModel):
    id: uuid.UUID
    slug: str
    name: str
    metadata: dict[str, Any] = Field(validation_alias="extra_metadata")
    created_at: dt.datetime


class WorkspaceList(BaseModel):
    items: list[WorkspaceView]


class ProjectCreate(BaseModel):
    id: uuid.UUID | None = None
    slug: Slug | None = None
    name: str = Field(min_length=1, max_length=256)
    metadata: dict[str, Any] = Field(default_factory=dict)

    _validate_id = field_validator("id")(_uuid7)

    @model_validator(mode="after")
    def fill_slug(self) -> ProjectCreate:
        self.slug = deterministic_slug(
            self.slug or self.name, fallback_prefix="project"
        )
        return self


class ProjectView(OrmModel):
    id: uuid.UUID
    workspace_id: uuid.UUID
    slug: str
    name: str
    metadata: dict[str, Any] = Field(validation_alias="extra_metadata")
    created_at: dt.datetime


class ProjectList(BaseModel):
    items: list[ProjectView]


class PeerCreate(BaseModel):
    id: uuid.UUID | None = None
    external_key: str = Field(min_length=1, max_length=256)
    name: str = Field(min_length=1, max_length=256)
    kind: Literal["human", "agent", "automation", "service"] = "human"
    metadata: dict[str, Any] = Field(default_factory=dict)

    _validate_id = field_validator("id")(_uuid7)


class PeerView(OrmModel):
    id: uuid.UUID
    workspace_id: uuid.UUID
    external_key: str
    name: str
    kind: str
    metadata: dict[str, Any] = Field(validation_alias="extra_metadata")
    created_at: dt.datetime


class SessionCreate(BaseModel):
    id: uuid.UUID | None = None
    external_key: str = Field(min_length=1, max_length=512)
    name: str = Field(min_length=1, max_length=512)
    source_app: str | None = Field(default=None, max_length=64)
    peer_ids: list[uuid.UUID] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)

    _validate_id = field_validator("id")(_uuid7)


class SessionView(OrmModel):
    id: uuid.UUID
    workspace_id: uuid.UUID
    project_id: uuid.UUID
    external_key: str
    name: str
    source_app: str | None
    created_at: dt.datetime


class RecordInput(BaseModel):
    id: uuid.UUID = Field(default_factory=uuid7)
    author_peer_id: uuid.UUID | None = None
    author_key: str | None = Field(default=None, min_length=1, max_length=256)
    author_name: str | None = Field(default=None, min_length=1, max_length=256)
    author_kind: Literal["human", "agent", "automation", "service"] = "human"
    kind: Literal["message", "file", "commit", "tool_result", "correction", "note"] = (
        "message"
    )
    content: str = Field(min_length=1, max_length=1_000_000)
    occurred_at: dt.datetime = Field(default_factory=lambda: dt.datetime.now(dt.UTC))
    source_app: str | None = Field(default=None, max_length=64)
    metadata: dict[str, Any] = Field(default_factory=dict)

    _validate_id = field_validator("id")(_uuid7)

    @field_validator("content")
    @classmethod
    def reject_nul(cls, value: str) -> str:
        if "\x00" in value:
            raise ValueError("content cannot contain NUL bytes")
        return value

    @model_validator(mode="after")
    def require_author_identity(self) -> RecordInput:
        if self.author_peer_id is None and self.author_key is None:
            raise ValueError("author_peer_id or author_key is required")
        return self


class RecordBatchCreate(BaseModel):
    records: list[RecordInput] = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def unique_record_ids(self) -> RecordBatchCreate:
        ids = [record.id for record in self.records]
        if len(ids) != len(set(ids)):
            raise ValueError("record ids must be unique within a batch")
        return self


class RecordBatchEnvelope(RecordBatchCreate):
    workspace_id: uuid.UUID
    project_id: uuid.UUID
    session_id: uuid.UUID


class RecordReceipt(BaseModel):
    id: uuid.UUID
    sequence: int
    content_hash: str
    created: bool
    segment_count: int


class RecordBatchReceipt(BaseModel):
    workspace_id: uuid.UUID
    project_id: uuid.UUID
    session_id: uuid.UUID
    records: list[RecordReceipt]
    jobs_created: int


class RecordView(OrmModel):
    id: uuid.UUID
    workspace_id: uuid.UUID
    project_id: uuid.UUID
    session_id: uuid.UUID
    author_peer_id: uuid.UUID
    sequence: int
    kind: str
    content: str
    content_hash: str
    occurred_at: dt.datetime
    source_app: str | None
    metadata: dict[str, Any] = Field(validation_alias="extra_metadata")
    created_at: dt.datetime


class RecallRequest(BaseModel):
    workspace_id: uuid.UUID
    project_id: uuid.UUID
    query: str = Field(min_length=1, max_length=10_000)
    include: set[Literal["records", "claims"]] = Field(
        default_factory=lambda: {"records", "claims"}
    )
    limit: int = Field(default=10, ge=1, le=100)
    session_id: uuid.UUID | None = None
    after: dt.datetime | None = None
    before: dt.datetime | None = None


class RecordHit(BaseModel):
    result_id: uuid.UUID
    node_id: uuid.UUID
    workspace_id: uuid.UUID
    project_id: uuid.UUID
    session_id: uuid.UUID
    record_id: uuid.UUID
    segment_id: uuid.UUID | None
    content: str
    matched_content: str
    created_at: dt.datetime
    rank: int
    rrf_score: float
    distance: float | None = None


class RecordSnippet(BaseModel):
    session_id: uuid.UUID
    matched_record_ids: list[uuid.UUID]
    records: list[RecordView]


class ClaimHit(BaseModel):
    result_id: uuid.UUID
    node_id: uuid.UUID
    workspace_id: uuid.UUID
    project_id: uuid.UUID
    session_id: uuid.UUID | None
    claim_id: uuid.UUID
    content: str
    derivation_method: str
    status: str
    evidence_ids: list[uuid.UUID]
    created_at: dt.datetime
    rank: int
    rrf_score: float
    distance: float | None = None


class RecallResponse(BaseModel):
    query: str
    records: list[RecordHit]
    record_snippets: list[RecordSnippet]
    claims: list[ClaimHit]
    embedding_used: bool


class RecordContextResponse(BaseModel):
    target_record_id: uuid.UUID
    records: list[RecordView]


class ClaimView(OrmModel):
    id: uuid.UUID
    workspace_id: uuid.UUID
    project_id: uuid.UUID
    session_id: uuid.UUID | None
    asserted_by_peer_id: uuid.UUID | None
    subject_peer_id: uuid.UUID | None
    content: str
    derivation_method: str
    status: str
    occurred_at: dt.datetime
    valid_from: dt.datetime | None
    valid_to: dt.datetime | None
    created_at: dt.datetime


class ClaimEvidenceItem(BaseModel):
    source_id: uuid.UUID
    role: str
    quote: str | None
    record: RecordView
    segment_id: uuid.UUID | None


class ClaimEvidenceResponse(BaseModel):
    claim: ClaimView
    evidence: list[ClaimEvidenceItem]


class ClaimListItem(BaseModel):
    claim: ClaimView
    evidence_count: int


class ClaimPage(BaseModel):
    items: list[ClaimListItem]
    next_cursor: str | None


class ProjectOverview(BaseModel):
    workspace_id: uuid.UUID
    project_id: uuid.UUID
    records: int
    claims: int
    sessions: int
    peers: int
    jobs: dict[str, int]
    last_ingested_at: dt.datetime | None
    embedding_configured: bool
    extraction_configured: bool
    mcp_url: str | None


class WikiClaim(BaseModel):
    claim_id: uuid.UUID
    content: str
    evidence_count: int
    evidence_ids: list[uuid.UUID]
    citations: list[WikiCitation]
    updated_at: dt.datetime


class WikiCitation(BaseModel):
    record_id: uuid.UUID
    quote: str | None


class WikiSection(BaseModel):
    title: str
    claims: list[WikiClaim]


class WikiResponse(BaseModel):
    workspace_id: uuid.UUID
    project_id: uuid.UUID
    generated_at: dt.datetime
    sections: list[WikiSection]


class GraphNode(BaseModel):
    id: str
    type: str
    label: str


class GraphEdge(BaseModel):
    id: uuid.UUID
    claim_id: uuid.UUID
    source: str
    predicate: str
    target: str


class GraphResponse(BaseModel):
    workspace_id: uuid.UUID
    project_id: uuid.UUID
    nodes: list[GraphNode]
    edges: list[GraphEdge]


class JobStatusResponse(BaseModel):
    workspace_id: uuid.UUID | None = None
    project_id: uuid.UUID | None = None
    counts: dict[str, int]


class JobView(OrmModel):
    id: uuid.UUID
    kind: str
    status: str
    attempts: int
    run_after: dt.datetime
    last_error: str | None
    completed_at: dt.datetime | None


class FailedJobRetryRequest(BaseModel):
    workspace_id: uuid.UUID
    project_id: uuid.UUID
    kinds: set[Literal["embed_record", "extract_claims", "embed_claim"]] | None = None
    limit: int = Field(default=1000, ge=1, le=10_000)


class FailedJobRetryResponse(BaseModel):
    retried: int


class SystemBacklog(BaseModel):
    counts: dict[str, int]
    oldest_pending_at: dt.datetime | None
    oldest_pending_seconds: float | None
    retrying: int
    failed: int


class HealthResponse(BaseModel):
    status: Literal["ok", "degraded"]
    database: bool
    embedding_configured: bool
    extraction_configured: bool
    embedding_provider_status: Literal[
        "unconfigured", "configured", "unknown", "ready", "error"
    ]
    embedding_provider_detail: str | None
    embedding_last_probe_at: dt.datetime | None
    extraction_provider_status: Literal[
        "unconfigured", "configured", "unknown", "ready", "error"
    ]
    extraction_provider_detail: str | None
    extraction_last_probe_at: dt.datetime | None
    job_counts: dict[str, int]
    version: str
