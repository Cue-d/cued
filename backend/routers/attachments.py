"""Attachment file serving router."""

import os

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse

from deps import get_chat_db
from services.attachments import AttachmentService, is_image_mime_type

router = APIRouter()

_attachment_service: AttachmentService | None = None


def get_attachment_service() -> AttachmentService:
    global _attachment_service
    if _attachment_service is None:
        _attachment_service = AttachmentService()
    return _attachment_service


@router.get("/{attachment_id}/file")
def get_attachment_file(attachment_id: int):
    """Serve an attachment file from ~/Library/Messages/Attachments/."""
    chat_db = get_chat_db()
    attachment = chat_db.get_attachment(attachment_id)

    if not attachment:
        raise HTTPException(status_code=404, detail="Attachment not found")

    service = get_attachment_service()
    file_path = service.resolve_path(attachment["path"])

    if not file_path:
        if not attachment["path"]:
            raise HTTPException(status_code=404, detail="Attachment path not available")
        raise HTTPException(status_code=404, detail="Attachment file not found on disk")

    # Determine media type
    media_type = attachment["mime_type"] or "application/octet-stream"

    return FileResponse(
        file_path,
        media_type=media_type,
        filename=attachment["filename"] or os.path.basename(file_path),
    )


@router.get("/{attachment_id}/thumbnail")
def get_attachment_thumbnail(attachment_id: int, size: int = Query(300, ge=50, le=1000)):
    """Generate and serve a thumbnail for image attachments.

    Thumbnails are cached in ~/.prm/thumbnails/ to avoid regenerating on each request.
    """
    chat_db = get_chat_db()
    attachment = chat_db.get_attachment(attachment_id)

    if not attachment:
        raise HTTPException(status_code=404, detail="Attachment not found")

    # Check if it's an image
    if not is_image_mime_type(attachment["mime_type"]):
        raise HTTPException(status_code=400, detail="Attachment is not an image")

    service = get_attachment_service()
    file_path = service.resolve_path(attachment["path"])

    if not file_path:
        if not attachment["path"]:
            raise HTTPException(status_code=404, detail="Attachment path not available")
        raise HTTPException(status_code=404, detail="Attachment file not found on disk")

    # Check for cached thumbnail
    if service.thumbnail_exists(attachment_id, size):
        return FileResponse(
            service.get_thumbnail_path(attachment_id, size),
            media_type="image/jpeg",
        )

    # Generate thumbnail
    try:
        thumbnail_path = service.generate_thumbnail(file_path, attachment_id, size)
        return FileResponse(thumbnail_path, media_type="image/jpeg")
    except ImportError:
        # PIL not available, serve original file
        return FileResponse(file_path, media_type=attachment["mime_type"] or "image/jpeg")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to generate thumbnail: {e}") from e
