"""Fail closed: a deployed ENVIRONMENT must not run on the built-in dev secret, and
must not run without an explicit ENCRYPTION_KEY (no silent derivation from
SECRET_KEY outside development)."""

import pytest
from cryptography.fernet import Fernet
from pydantic import ValidationError

from app import crypto
from app.config import Settings

_DEPLOYED = ["production", "Production", "PROD", " staging "]


def _mk(**overrides) -> Settings:
    base = {"ENVIRONMENT": "development", "SECRET_KEY": "dev-secret"}
    return Settings(**{**base, **overrides})


def test_development_allows_the_default_secret():
    assert _mk().SECRET_KEY == "dev-secret"


@pytest.mark.parametrize("env", _DEPLOYED)
def test_deployed_env_rejects_default_secret_key(env):
    with pytest.raises(ValidationError, match="SECRET_KEY"):
        _mk(ENVIRONMENT=env)


def test_deployed_env_accepts_a_real_secret_and_key():
    s = _mk(ENVIRONMENT="production", SECRET_KEY="a-genuine-pepper-value", ENCRYPTION_KEY="x")
    assert s.ENVIRONMENT == "production"


# ---- ENCRYPTION_KEY is mandatory when deployed ----


@pytest.mark.parametrize("env", _DEPLOYED)
def test_deployed_env_without_encryption_key_fails_fast(env):
    with pytest.raises(ValidationError, match="ENCRYPTION_KEY is required"):
        _mk(ENVIRONMENT=env, SECRET_KEY="a-genuine-pepper-value", ENCRYPTION_KEY="")


@pytest.mark.parametrize("blank", ["", "   ", "\t\n"])
def test_blank_encryption_key_counts_as_missing(blank):
    with pytest.raises(ValidationError, match="ENCRYPTION_KEY is required"):
        _mk(ENVIRONMENT="production", SECRET_KEY="a-genuine-pepper-value", ENCRYPTION_KEY=blank)


@pytest.mark.parametrize("env", _DEPLOYED)
def test_deployed_env_with_encryption_key_is_valid(env):
    key = Fernet.generate_key().decode()
    s = _mk(ENVIRONMENT=env, SECRET_KEY="a-genuine-pepper-value", ENCRYPTION_KEY=key)
    assert s.ENCRYPTION_KEY == key


def test_both_problems_are_reported_together():
    with pytest.raises(ValidationError) as exc:
        _mk(ENVIRONMENT="production", ENCRYPTION_KEY="")  # dev secret AND no key
    assert "SECRET_KEY" in str(exc.value) and "ENCRYPTION_KEY" in str(exc.value)


# ---- development / test behavior is unchanged ----


@pytest.mark.parametrize("env", ["development", "test", ""])
def test_non_deployed_env_may_omit_encryption_key(env):
    s = _mk(ENVIRONMENT=env, ENCRYPTION_KEY="")
    assert s.ENCRYPTION_KEY == ""


def test_dev_encryption_still_derives_from_secret_key_and_round_trips(monkeypatch):
    """With no ENCRYPTION_KEY (dev/test), crypto must keep deriving one from
    SECRET_KEY, or every stored-credential test would break."""
    monkeypatch.setattr(crypto.settings, "ENCRYPTION_KEY", "")
    token = crypto.encrypt("sk-secret-provider-key")
    assert crypto.decrypt(token) == "sk-secret-provider-key"
