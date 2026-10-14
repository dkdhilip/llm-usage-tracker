"""Read-only developer-integration guide for the dashboard ("Connect your app").

Returns copy-ready, per-provider setup text (URLs, environment variables, code) built by
app.integration from the one configured gateway URL (settings.GATEWAY_PUBLIC_URL /
GATEWAY_LOCAL_URL). It never contains a key — only the `vk_...` placeholder — so it needs no more
than a signed-in workspace member."""

from fastapi import APIRouter, Depends, HTTPException, Query

from app import integration
from app.config import settings
from app.workspace import require_membership

router = APIRouter(
    prefix="/api/integration", tags=["integration"], dependencies=[Depends(require_membership)]
)


@router.get("")
def get_integration_guide(target: str = Query("hosted", pattern="^(hosted|local)$")) -> dict:
    try:
        return integration.build_guide(settings.GATEWAY_PUBLIC_URL, settings.GATEWAY_LOCAL_URL, target)
    except ValueError as exc:  # a misconfigured GATEWAY_*_URL — an operator error, not the caller's
        raise HTTPException(500, f"gateway URL configuration is invalid: {exc}") from exc
