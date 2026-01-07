"""Shared utility functions."""


def is_image_mime_type(mime_type: str | None) -> bool:
    """Check if a MIME type is an image."""
    return bool(mime_type and mime_type.startswith("image/"))
