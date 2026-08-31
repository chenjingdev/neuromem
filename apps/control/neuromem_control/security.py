from __future__ import annotations

import base64
import datetime as dt
import hashlib
import hmac
import json
import secrets
from dataclasses import dataclass
from typing import Annotated

from fastapi import Cookie, Depends, Header, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import Settings, get_settings
from .db import db_session
from .ids import uuid7
from .models import (
    AgentPeerOwnership,
    Credential,
    Principal,
    PrincipalPeerLink,
    Project,
    ProjectGrant,
    WebSession,
    WorkspaceMembership,
    utcnow,
)
from .schemas import AuthContext

ROLE_CAPABILITIES: dict[str, set[str]] = {
    "owner": {
        "workspace.read",
        "workspace.admin",
        "project.create",
        "project.read",
        "project.write",
        "project.grant",
        "wiki.read",
        "wiki.write",
        "credential.manage",
        "invitation.manage",
        "agent.manage",
        "federation.manage",
        "transfer.manage",
        "audit.read",
    },
    "admin": {
        "workspace.read",
        "workspace.admin",
        "project.create",
        "project.read",
        "project.write",
        "project.grant",
        "wiki.read",
        "wiki.write",
        "credential.manage",
        "invitation.manage",
        "agent.manage",
        "federation.manage",
        "transfer.manage",
        "audit.read",
    },
    "contributor": {
        "workspace.read",
        "project.read",
        "project.write",
        "wiki.read",
        "wiki.write",
        "credential.self",
        "agent.self",
        "transfer.request",
    },
    "viewer": {
        "workspace.read",
        "project.read",
        "wiki.read",
        "credential.self",
    },
}

SESSION_COOKIE = "neuromem_session"
bearer = HTTPBearer(auto_error=False)


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _unb64(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32)
    return f"scrypt$16384$8$1${_b64(salt)}${_b64(digest)}"


def verify_password(password: str, encoded: str | None) -> bool:
    if not encoded:
        return False
    try:
        algorithm, n, r, p, salt, expected = encoded.split("$")
        if algorithm != "scrypt":
            return False
        actual = hashlib.scrypt(
            password.encode(),
            salt=_unb64(salt),
            n=int(n),
            r=int(r),
            p=int(p),
            dklen=len(_unb64(expected)),
        )
        return hmac.compare_digest(actual, _unb64(expected))
    except (ValueError, TypeError):
        return False


def generate_secret(kind: str) -> tuple[str, str]:
    opaque = secrets.token_urlsafe(32)
    prefix = opaque[:12]
    return f"nmc_{kind}_{opaque}", prefix


def token_prefix(token: str) -> str | None:
    parts = token.split("_", 2)
    if len(parts) != 3 or parts[0] != "nmc":
        return None
    return parts[2][:12]


def token_digest(token: str, secret_key: str) -> str:
    return hmac.new(secret_key.encode(), token.encode(), hashlib.sha256).hexdigest()


def verify_token(token: str, expected_digest: str, secret_key: str) -> bool:
    return hmac.compare_digest(token_digest(token, secret_key), expected_digest)


def _unauthorized() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="invalid or expired authentication",
        headers={"WWW-Authenticate": "Bearer"},
    )


def _forbidden(detail: str = "permission denied") -> HTTPException:
    return HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=detail)


@dataclass(frozen=True)
class Authenticated:
    principal: Principal
    context: AuthContext
    credential: Credential | None = None
    web_session: WebSession | None = None


def _context_for(
    *,
    db: Session,
    principal: Principal,
    request_id: str,
    workspace_id: str | None,
    project_id: str | None,
    credential: Credential | None,
) -> AuthContext:
    selected_workspace = workspace_id or (
        credential.workspace_id if credential else None
    )
    selected_project = project_id
    human_peer_id: str | None = None
    agent_peer_id: str | None = credential.agent_peer_id if credential else None
    capabilities: set[str] = {"workspace.create"}

    if selected_workspace:
        membership = db.scalar(
            select(WorkspaceMembership).where(
                WorkspaceMembership.workspace_id == selected_workspace,
                WorkspaceMembership.principal_id == principal.id,
                WorkspaceMembership.status == "active",
            )
        )
        if membership is None:
            raise _forbidden("active workspace membership required")
        capabilities = set(ROLE_CAPABILITIES[membership.role])
        human_peer_id = db.scalar(
            select(PrincipalPeerLink.peer_id).where(
                PrincipalPeerLink.workspace_id == selected_workspace,
                PrincipalPeerLink.principal_id == principal.id,
                PrincipalPeerLink.status == "active",
            )
        )

        if credential:
            if credential.workspace_id != selected_workspace:
                raise _forbidden("credential is bound to another workspace")
            if credential.capabilities:
                capabilities &= set(credential.capabilities)
            if agent_peer_id:
                ownership = db.scalar(
                    select(AgentPeerOwnership).where(
                        AgentPeerOwnership.workspace_id == selected_workspace,
                        AgentPeerOwnership.agent_peer_id == agent_peer_id,
                        AgentPeerOwnership.status == "active",
                    )
                )
                if ownership is None:
                    raise _forbidden("credential agent peer is inactive or foreign")
                if ownership.owner_principal_id not in (None, principal.id):
                    raise _forbidden("credential does not own its agent peer")

        if selected_project:
            project = db.scalar(
                select(Project).where(
                    Project.id == selected_project,
                    Project.workspace_id == selected_workspace,
                    Project.status == "active",
                )
            )
            if project is None:
                raise _forbidden("project is not in the selected workspace")
            if credential and credential.project_ids:
                if selected_project not in credential.project_ids:
                    raise _forbidden("credential is not scoped to this project")
            if project.access_policy == "restricted" and membership.role not in {
                "owner",
                "admin",
            }:
                grant = db.scalar(
                    select(ProjectGrant).where(
                        ProjectGrant.project_id == selected_project,
                        ProjectGrant.principal_id == principal.id,
                        ProjectGrant.status == "active",
                    )
                )
                if grant is None:
                    capabilities -= {
                        "project.read",
                        "project.write",
                        "wiki.read",
                        "wiki.write",
                    }
                else:
                    project_caps = set(grant.capabilities)
                    capabilities &= project_caps | {
                        "workspace.read",
                        "credential.self",
                        "agent.self",
                    }

    return AuthContext(
        principal_id=principal.id,
        credential_id=credential.id if credential else None,
        workspace_id=selected_workspace,
        project_id=selected_project,
        human_peer_id=human_peer_id,
        agent_peer_id=agent_peer_id,
        capabilities=sorted(capabilities),
        request_id=request_id,
    )


def authenticate_request(
    request: Request,
    db: Annotated[Session, Depends(db_session)],
    settings: Annotated[Settings, Depends(get_settings)],
    authorization: Annotated[
        HTTPAuthorizationCredentials | None, Depends(bearer)
    ] = None,
    session_cookie: Annotated[str | None, Cookie(alias=SESSION_COOKIE)] = None,
    workspace_header: Annotated[
        str | None, Header(alias="X-Neuromem-Workspace")
    ] = None,
    project_header: Annotated[str | None, Header(alias="X-Neuromem-Project")] = None,
    request_id: Annotated[str | None, Header(alias="X-Request-ID")] = None,
) -> Authenticated:
    now = utcnow()
    rid = request_id or str(uuid7())
    credential: Credential | None = None
    web_session: WebSession | None = None

    if authorization:
        raw = authorization.credentials
        prefix = token_prefix(raw)
        if not prefix:
            raise _unauthorized()
        credential = db.scalar(
            select(Credential).where(Credential.token_prefix == prefix)
        )
        if (
            credential is None
            or credential.revoked_at is not None
            or (credential.expires_at is not None and credential.expires_at <= now)
            or not verify_token(raw, credential.token_digest, settings.secret_key)
        ):
            raise _unauthorized()
        principal = db.get(Principal, credential.principal_id)
        credential.last_used_at = now
    elif session_cookie:
        prefix = token_prefix(session_cookie)
        if not prefix:
            raise _unauthorized()
        web_session = db.scalar(
            select(WebSession).where(WebSession.token_prefix == prefix)
        )
        if (
            web_session is None
            or web_session.revoked_at is not None
            or web_session.idle_expires_at <= now
            or web_session.absolute_expires_at <= now
            or not verify_token(
                session_cookie, web_session.token_digest, settings.secret_key
            )
        ):
            raise _unauthorized()
        principal = db.get(Principal, web_session.principal_id)
        web_session.last_seen_at = now
        refreshed = now + dt.timedelta(seconds=settings.web_session_idle_seconds)
        web_session.idle_expires_at = min(refreshed, web_session.absolute_expires_at)
    else:
        raise _unauthorized()

    if principal is None or principal.status != "active":
        raise _unauthorized()
    routed_project = project_header or request.path_params.get("project_id")
    routed_workspace = (
        workspace_header
        or request.path_params.get("workspace_id")
        or request.query_params.get("workspace_id")
    )
    if routed_project and routed_workspace is None:
        routed_workspace = db.scalar(
            select(Project.workspace_id).where(Project.id == routed_project)
        )
    context = _context_for(
        db=db,
        principal=principal,
        request_id=rid,
        workspace_id=routed_workspace,
        project_id=routed_project,
        credential=credential,
    )
    db.commit()
    request.state.auth = context
    return Authenticated(
        principal=principal,
        context=context,
        credential=credential,
        web_session=web_session,
    )


CurrentAuth = Annotated[Authenticated, Depends(authenticate_request)]


def require_capability(auth: Authenticated, capability: str) -> None:
    if capability not in auth.context.capabilities:
        raise _forbidden(f"missing capability: {capability}")


def require_workspace(auth: Authenticated, workspace_id: str) -> None:
    if auth.context.workspace_id != workspace_id:
        raise _forbidden("request workspace does not match authenticated context")


class InternalTokenSigner:
    """Signs short-lived, gateway-to-core AuthContext envelopes."""

    def __init__(self, secret_key: str):
        self.secret_key = secret_key.encode()

    def mint(
        self, context: AuthContext, *, ttl_seconds: int = 60
    ) -> tuple[str, dt.datetime]:
        now = utcnow()
        expires_at = now + dt.timedelta(seconds=ttl_seconds)
        payload = {
            "v": 1,
            "iat": int(now.timestamp()),
            "exp": int(expires_at.timestamp()),
            "context": context.model_dump(mode="json"),
        }
        encoded = _b64(
            json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
        )
        signature = _b64(
            hmac.new(self.secret_key, encoded.encode(), hashlib.sha256).digest()
        )
        return f"nmic1.{encoded}.{signature}", expires_at

    def verify(self, token: str, *, now: dt.datetime | None = None) -> AuthContext:
        try:
            version, encoded, signature = token.split(".")
            if version != "nmic1":
                raise ValueError
            expected = _b64(
                hmac.new(self.secret_key, encoded.encode(), hashlib.sha256).digest()
            )
            if not hmac.compare_digest(signature, expected):
                raise ValueError
            payload = json.loads(_unb64(encoded))
            instant = now or utcnow()
            if payload.get("v") != 1 or int(payload["exp"]) <= int(instant.timestamp()):
                raise ValueError
            return AuthContext.model_validate(payload["context"])
        except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
            raise ValueError("invalid or expired internal context token") from error
