"""Attachments package - file serving and thumbnail generation."""

from .service import AttachmentService, is_image_mime_type

__all__ = [
    "AttachmentService",
    "is_image_mime_type",
]
