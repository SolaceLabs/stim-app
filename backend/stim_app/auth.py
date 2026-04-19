"""Azure AD (Entra ID) OIDC auth with signed-cookie sessions.

Mirrors the pattern used in sam-ent / solace-chat at a smaller scale:
- /api/auth/login     -> redirect to Azure authorize endpoint
- /api/auth/callback  -> exchange code, verify id_token via JWKS, set cookie
- /api/auth/me        -> return current user (or 401)
- /api/auth/logout    -> clear cookie

Sessions are stateless: the cookie is a short-lived JWT signed with a
server secret, carrying {sub, email, name, exp}. No Redis.

Set STIM_APP_DISABLE_AUTH=1 to bypass auth locally (acts as user "local").
"""
from __future__ import annotations

import hashlib
import json
import os
import secrets
import time
from dataclasses import dataclass
from typing import Optional
from urllib.parse import urlencode

import httpx
import jwt
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
from jwt.algorithms import RSAAlgorithm

SESSION_COOKIE = "stim_session"
STATE_COOKIE = "stim_oauth_state"
SESSION_TTL = 8 * 3600  # 8 hours


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default)


def _cfg():
    return {
        "tenant": _env("AZURE_TENANT_ID"),
        "client_id": _env("AZURE_CLIENT_ID"),
        "client_secret": _env("AZURE_CLIENT_SECRET"),
        "redirect_uri": _env("STIM_APP_AUTH_REDIRECT", "http://localhost:8787/api/auth/callback"),
        "session_secret": _env("STIM_APP_SESSION_SECRET") or _env("SESSION_SECRET_KEY") or "dev-only-change-me",
        "post_login_redirect": _env("STIM_APP_POST_LOGIN", "/"),
    }


@dataclass
class User:
    sub: str
    email: Optional[str]
    name: Optional[str]

    @property
    def dir_key(self) -> str:
        # Opaque directory name; avoids putting raw email on disk.
        return hashlib.sha256(self.sub.encode("utf-8")).hexdigest()[:20]


# --- JWKS cache ---
_jwks = {"at": 0.0, "keys": {}}


def _jwks_url(tenant: str) -> str:
    return f"https://login.microsoftonline.com/{tenant}/discovery/v2.0/keys"


def _get_jwks(tenant: str, force: bool = False) -> dict:
    now = time.time()
    if not force and now - _jwks["at"] < 3600 and _jwks["keys"]:
        return _jwks["keys"]
    r = httpx.get(_jwks_url(tenant), timeout=5.0)
    r.raise_for_status()
    _jwks["keys"] = {k["kid"]: k for k in r.json().get("keys", [])}
    _jwks["at"] = now
    return _jwks["keys"]


# --- Session cookie ---

def _sign_session(user: User, secret: str) -> str:
    return jwt.encode(
        {
            "sub": user.sub,
            "email": user.email,
            "name": user.name,
            "exp": int(time.time()) + SESSION_TTL,
        },
        secret,
        algorithm="HS256",
    )


def _verify_session(token: str, secret: str) -> Optional[User]:
    try:
        p = jwt.decode(token, secret, algorithms=["HS256"])
        return User(sub=p["sub"], email=p.get("email"), name=p.get("name"))
    except Exception:
        return None


def current_user_optional(request: Request) -> Optional[User]:
    if os.environ.get("STIM_APP_DISABLE_AUTH") == "1":
        return User(sub="local-dev", email="local@dev", name="Local Dev")
    tok = request.cookies.get(SESSION_COOKIE)
    if not tok:
        return None
    return _verify_session(tok, _cfg()["session_secret"])


def get_current_user(request: Request) -> User:
    u = current_user_optional(request)
    if not u:
        raise HTTPException(status_code=401, detail="not authenticated")
    return u


# --- Routes ---
auth_router = APIRouter(prefix="/api/auth")


@auth_router.get("/me")
def me(user: User = Depends(get_current_user)):
    return {"sub": user.sub, "email": user.email, "name": user.name}


@auth_router.get("/config")
def auth_config():
    c = _cfg()
    return {
        "configured": bool(c["tenant"] and c["client_id"]),
        "disabled": os.environ.get("STIM_APP_DISABLE_AUTH") == "1",
    }


@auth_router.get("/login")
def login(next: str = "/"):
    c = _cfg()
    if not (c["tenant"] and c["client_id"]):
        raise HTTPException(500, "Azure auth not configured (AZURE_TENANT_ID, AZURE_CLIENT_ID)")
    state = secrets.token_urlsafe(24)
    state_token = jwt.encode(
        {"state": state, "next": next, "exp": int(time.time()) + 600},
        c["session_secret"],
        algorithm="HS256",
    )
    q = urlencode({
        "client_id": c["client_id"],
        "response_type": "code",
        "redirect_uri": c["redirect_uri"],
        "response_mode": "query",
        "scope": "openid profile email",
        "state": state,
    })
    url = f"https://login.microsoftonline.com/{c['tenant']}/oauth2/v2.0/authorize?{q}"
    resp = RedirectResponse(url=url)
    resp.set_cookie(STATE_COOKIE, state_token, httponly=True, max_age=600, samesite="lax")
    return resp


@auth_router.get("/callback")
def callback(request: Request, code: str, state: str):
    c = _cfg()
    st_cookie = request.cookies.get(STATE_COOKIE)
    if not st_cookie:
        raise HTTPException(400, "missing state cookie")
    try:
        sp = jwt.decode(st_cookie, c["session_secret"], algorithms=["HS256"])
    except Exception:
        raise HTTPException(400, "invalid state cookie")
    if sp.get("state") != state:
        raise HTTPException(400, "state mismatch")

    token_url = f"https://login.microsoftonline.com/{c['tenant']}/oauth2/v2.0/token"
    r = httpx.post(token_url, data={
        "client_id": c["client_id"],
        "client_secret": c["client_secret"],
        "code": code,
        "redirect_uri": c["redirect_uri"],
        "grant_type": "authorization_code",
        "scope": "openid profile email",
    }, timeout=10.0)
    if r.status_code != 200:
        raise HTTPException(400, f"token exchange failed: {r.text}")
    tokens = r.json()
    id_token = tokens.get("id_token")
    if not id_token:
        raise HTTPException(400, "no id_token in response")

    header = jwt.get_unverified_header(id_token)
    kid = header.get("kid")
    keys = _get_jwks(c["tenant"])
    jwk = keys.get(kid)
    if not jwk:
        keys = _get_jwks(c["tenant"], force=True)
        jwk = keys.get(kid)
    if not jwk:
        raise HTTPException(400, "signing key not found")
    pub = RSAAlgorithm.from_jwk(json.dumps(jwk))
    try:
        claims = jwt.decode(
            id_token, pub, algorithms=["RS256"],
            audience=c["client_id"],
            issuer=f"https://login.microsoftonline.com/{c['tenant']}/v2.0",
        )
    except Exception as e:
        raise HTTPException(400, f"id_token invalid: {e}")

    user = User(
        sub=str(claims.get("oid") or claims["sub"]),
        email=claims.get("email") or claims.get("preferred_username"),
        name=claims.get("name"),
    )
    session = _sign_session(user, c["session_secret"])
    next_url = sp.get("next") or c["post_login_redirect"] or "/"
    resp = RedirectResponse(url=next_url)
    resp.set_cookie(SESSION_COOKIE, session, httponly=True, max_age=SESSION_TTL, samesite="lax")
    resp.delete_cookie(STATE_COOKIE)
    return resp


@auth_router.post("/logout")
def logout():
    resp = Response(status_code=204)
    resp.delete_cookie(SESSION_COOKIE)
    return resp
