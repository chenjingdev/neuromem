from __future__ import annotations

import datetime as dt
import json
import math
from dataclasses import dataclass
from typing import Any, Literal

from openai import (
    APIConnectionError,
    APITimeoutError,
    AsyncOpenAI,
    BadRequestError,
    InternalServerError,
    RateLimitError,
)
from pydantic import AliasChoices, BaseModel, Field, field_validator, model_validator

from .config import Settings, get_settings


class ProviderUnavailable(RuntimeError):
    pass


class TransientProviderError(RuntimeError):
    pass


_TRANSIENT_PROVIDER_ERRORS = (
    APIConnectionError,
    APITimeoutError,
    InternalServerError,
    RateLimitError,
)


@dataclass
class ProviderProbe:
    status: str = "unknown"
    detail: str | None = None
    last_probe_at: dt.datetime | None = None
    signature: tuple[str | None, str | None] | None = None


_embedding_probe = ProviderProbe()
_extraction_probe = ProviderProbe()


def provider_health(settings: Settings) -> tuple[ProviderProbe, ProviderProbe]:
    if settings.embedding_configured:
        embedding = _embedding_probe
        expected_signature = (settings.embedding_base_url, settings.embedding_model)
        if embedding.status == "unknown" or embedding.signature != expected_signature:
            embedding = ProviderProbe(status="configured")
    else:
        embedding = ProviderProbe(
            status="unconfigured", detail="embedding provider not configured"
        )
    if settings.extraction_configured:
        extraction = _extraction_probe
        expected_signature = (settings.generation_base_url, settings.generation_model)
        if extraction.status == "unknown" or extraction.signature != expected_signature:
            extraction = ProviderProbe(status="configured")
    else:
        extraction = ProviderProbe(
            status="unconfigured", detail="generation provider not configured"
        )
    return embedding, extraction


def _record_probe(
    probe: ProviderProbe,
    *,
    signature: tuple[str | None, str | None],
    error: BaseException | None = None,
) -> None:
    probe.last_probe_at = dt.datetime.now(dt.UTC)
    probe.signature = signature
    if error is None:
        probe.status = "ready"
        probe.detail = None
        return
    probe.status = "error"
    if isinstance(error, ValueError) and "embedding" in str(error).lower():
        probe.detail = str(error)[:500]
    else:
        probe.detail = type(error).__name__


class ExtractedClaim(BaseModel):
    content: str = Field(
        min_length=1,
        max_length=65_535,
        validation_alias=AliasChoices("content", "claim", "text", "statement"),
    )
    subject_label: str | None = Field(default=None, max_length=512)
    predicate: str | None = Field(default=None, max_length=128)
    object_label: str | None = Field(default=None, max_length=512)
    object_type: Literal["peer", "project", "literal"] = "literal"
    quote: str | None = Field(default=None, max_length=2_000)

    @model_validator(mode="before")
    @classmethod
    def synthesize_relation_content(cls, value: Any) -> Any:
        if not isinstance(value, dict):
            return value
        data = dict(value)
        if any(data.get(key) for key in ("content", "claim", "text", "statement")):
            return data
        subject = data.get("subject_label")
        predicate = data.get("predicate")
        object_label = data.get("object_label")
        if all(
            isinstance(item, str) and item.strip()
            for item in (subject, predicate, object_label)
        ):
            readable_predicate = " ".join(predicate.strip().replace("_", " ").split())
            data["content"] = (
                f"{subject.strip()} {readable_predicate} {object_label.strip()}"
            )
        return data

    @field_validator("content", "subject_label", "predicate", "object_label", "quote")
    @classmethod
    def strip_strings(cls, value: str | None) -> str | None:
        if value is None:
            return None
        stripped = value.strip()
        return stripped or None


class ExtractionResult(BaseModel):
    claims: list[ExtractedClaim] = Field(default_factory=list, max_length=8)

    @model_validator(mode="before")
    @classmethod
    def accept_single_claim_object(cls, value: Any) -> Any:
        if isinstance(value, dict) and "claims" not in value:
            if any(
                key in value
                for key in (
                    "content",
                    "claim",
                    "text",
                    "statement",
                    "subject_label",
                )
            ):
                return {"claims": [value]}
        return value


def _secret(value: Any) -> str:
    if value is None:
        return "local-placeholder"
    resolved = value.get_secret_value().strip()
    return resolved or "local-placeholder"


def normalize_vector(values: list[float], dimensions: int = 2560) -> list[float]:
    if len(values) != dimensions:
        raise ValueError(
            f"expected {dimensions} embedding values, received {len(values)}"
        )
    norm = math.sqrt(sum(float(value) * float(value) for value in values))
    if not math.isfinite(norm) or norm == 0:
        raise ValueError("embedding has invalid L2 norm")
    return [float(value) / norm for value in values]


class ModelProviders:
    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()

    def _embedding_client(self) -> AsyncOpenAI:
        if not self.settings.embedding_configured:
            raise ProviderUnavailable("embedding provider is not configured")
        return AsyncOpenAI(
            base_url=self.settings.embedding_base_url,
            api_key=_secret(self.settings.embedding_api_key),
        )

    def _generation_client(self) -> AsyncOpenAI:
        if not self.settings.extraction_configured:
            raise ProviderUnavailable("generation provider is not configured")
        return AsyncOpenAI(
            base_url=self.settings.generation_base_url,
            api_key=_secret(self.settings.generation_api_key),
        )

    async def embed_texts(
        self, texts: list[str], *, query: bool = False
    ) -> list[list[float]]:
        if not texts:
            return []
        prepared = list(texts)
        instruction = self.settings.embedding_query_instruction
        if query and instruction:
            prepared = [
                f"Instruct: {instruction.strip()}\nQuery: {text}" for text in texts
            ]

        kwargs: dict[str, Any] = {
            "model": self.settings.embedding_model,
            "input": prepared,
        }
        if self.settings.embedding_send_dimensions:
            kwargs["dimensions"] = self.settings.embedding_dimensions
        try:
            response = await self._embedding_client().embeddings.create(**kwargs)
            if len(response.data) != len(texts):
                raise ValueError(
                    "embedding provider returned the wrong number of vectors"
                )
            vectors = [
                normalize_vector(item.embedding, self.settings.embedding_dimensions)
                for item in response.data
            ]
        except _TRANSIENT_PROVIDER_ERRORS as error:
            _record_probe(
                _embedding_probe,
                signature=(
                    self.settings.embedding_base_url,
                    self.settings.embedding_model,
                ),
                error=error,
            )
            raise TransientProviderError(type(error).__name__) from error
        except Exception as error:
            _record_probe(
                _embedding_probe,
                signature=(
                    self.settings.embedding_base_url,
                    self.settings.embedding_model,
                ),
                error=error,
            )
            raise
        _record_probe(
            _embedding_probe,
            signature=(self.settings.embedding_base_url, self.settings.embedding_model),
        )
        return vectors

    async def extract_claims(
        self,
        *,
        author_name: str,
        content: str,
        occurred_at: str,
        context: list[tuple[str, str]],
    ) -> ExtractionResult:
        context_text = "\n".join(
            f"{speaker}: {message}" for speaker, message in context
        )
        prompt = (
            "Identify at most eight concise claims directly stated by the target "
            "record. "
            "Only preserve explicit facts, decisions, and reported results. "
            "Never infer personality, psychology, motives, intentions, or unstated "
            "causes. "
            "Nearby records may only resolve pronouns or omitted names; they are not "
            "evidence "
            "for a claim and must not contribute new facts. "
            "Do not add background knowledge or assumptions. Each claim must stand "
            "alone. "
            "Write content in the target record's language; never translate it. "
            "Use subject_label, predicate, and object_label only when the relation is "
            "explicit. "
            "If quote is supplied it must be an exact substring of the target record. "
            "Return exactly this JSON shape: "
            '{"claims":[{"content":"required self-contained claim",'
            '"subject_label":null,"predicate":null,"object_label":null,'
            '"object_type":"literal","quote":null}]}. '
            "The content field is required for every item. An empty claims array "
            "is valid.\n\n"
            f"Author: {author_name}\nOccurred at: {occurred_at}\n"
            f"Nearby records:\n{context_text}\n\nTarget record:\n{content}"
        )
        try:
            messages = [
                {
                    "role": "system",
                    "content": (
                        "You extract strictly source-grounded project memory "
                        "as JSON. "
                        "Do not infer traits, psychology, motives, or intentions."
                    ),
                },
                {"role": "user", "content": prompt},
            ]
            try:
                response = await self._generation_client().chat.completions.create(
                    model=self.settings.generation_model,
                    messages=messages,
                    response_format={
                        "type": "json_schema",
                        "json_schema": {
                            "name": "neuromem_claims",
                            "strict": True,
                            "schema": ExtractionResult.model_json_schema(),
                        },
                    },
                    temperature=0,
                )
            except BadRequestError:
                response = await self._generation_client().chat.completions.create(
                    model=self.settings.generation_model,
                    messages=messages,
                    response_format={"type": "json_object"},
                    temperature=0,
                )
            raw = response.choices[0].message.content or "{}"
            result = ExtractionResult.model_validate(json.loads(raw))
        except _TRANSIENT_PROVIDER_ERRORS as error:
            _record_probe(
                _extraction_probe,
                signature=(
                    self.settings.generation_base_url,
                    self.settings.generation_model,
                ),
                error=error,
            )
            raise TransientProviderError(type(error).__name__) from error
        except Exception as error:
            _record_probe(
                _extraction_probe,
                signature=(
                    self.settings.generation_base_url,
                    self.settings.generation_model,
                ),
                error=error,
            )
            raise
        _record_probe(
            _extraction_probe,
            signature=(
                self.settings.generation_base_url,
                self.settings.generation_model,
            ),
        )
        return result
