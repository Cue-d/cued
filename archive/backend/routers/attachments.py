"""Attachment file serving router."""

import os

import core
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

# Register HEIF/HEIC opener for Pillow (needed for iPhone images)
try:
    import pillow_heif

    pillow_heif.register_heif_opener()
except ImportError:
    pass  # pillow-heif not installed, HEIC support unavailable

router = APIRouter()

# Config
APP_DB_PATH = os.path.expanduser("~/.prm/prm.db")
THUMBNAIL_CACHE_DIR = os.path.expanduser("~/.prm/thumbnails")


def get_app_db() -> core.AppDb:
    """Get the app database."""
    db = core.AppDb(APP_DB_PATH)
    db.init_schema()
    return db


@router.get("/{attachment_id}/file")
def get_attachment_file(attachment_id: int):
    """Serve an attachment file from ~/Library/Messages/Attachments/."""
    db = get_app_db()
    attachment = db.get_attachment(attachment_id)

    if not attachment:
        raise HTTPException(status_code=404, detail="Attachment not found")

    if not attachment.path:
        raise HTTPException(status_code=404, detail="Attachment path not available")

    # Expand ~ and resolve the path
    file_path = os.path.expanduser(attachment.path)

    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="Attachment file not found on disk")

    # Determine media type
    media_type = attachment.mime_type or "application/octet-stream"

    return FileResponse(
        file_path,
        media_type=media_type,
        filename=attachment.filename or os.path.basename(file_path),
    )


@router.get("/{attachment_id}/thumbnail")
def get_attachment_thumbnail(attachment_id: int, size: int = 300):
    """Generate and serve a thumbnail for image attachments.

    Thumbnails are cached in ~/.prm/thumbnails/ to avoid regenerating on each request.
    """
    db = get_app_db()
    attachment = db.get_attachment(attachment_id)

    if not attachment:
        raise HTTPException(status_code=404, detail="Attachment not found")

    if not attachment.path:
        raise HTTPException(status_code=404, detail="Attachment path not available")

    # Check if it's an image
    mime_type = attachment.mime_type or ""
    if not mime_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Attachment is not an image")

    # Expand ~ and resolve the path
    file_path = os.path.expanduser(attachment.path)

    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="Attachment file not found on disk")

    # Check for cached thumbnail
    os.makedirs(THUMBNAIL_CACHE_DIR, exist_ok=True)
    thumbnail_path = os.path.join(THUMBNAIL_CACHE_DIR, f"{attachment_id}_{size}.jpg")

    if not os.path.exists(thumbnail_path):
        # Generate thumbnail using PIL
        try:
            from PIL import Image

            with Image.open(file_path) as img:
                # Convert to RGB if necessary (HEIC, PNG with transparency, etc.)
                if img.mode != "RGB":
                    img = img.convert("RGB")

                # Resize maintaining aspect ratio
                img.thumbnail((size, size), Image.Resampling.LANCZOS)
                img.save(thumbnail_path, "JPEG", quality=85)
        except ImportError:
            # PIL not available, serve original file
            return FileResponse(file_path, media_type=mime_type)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to generate thumbnail: {e}") from e

    return FileResponse(thumbnail_path, media_type="image/jpeg")
