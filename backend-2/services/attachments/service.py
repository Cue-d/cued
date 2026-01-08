"""Attachment service - file path resolution and thumbnail generation."""

import os

# Register HEIF/HEIC opener for Pillow (needed for iPhone images)
try:
    import pillow_heif

    pillow_heif.register_heif_opener()
except ImportError:
    pass  # pillow-heif not installed, HEIC support unavailable

THUMBNAIL_CACHE_DIR = os.path.expanduser("~/.prm/thumbnails")


def is_image_mime_type(mime_type: str | None) -> bool:
    """Check if a MIME type is an image."""
    return bool(mime_type and mime_type.startswith("image/"))


class AttachmentService:
    """Service for attachment file operations."""

    def __init__(self, thumbnail_cache_dir: str = THUMBNAIL_CACHE_DIR):
        self.thumbnail_cache_dir = thumbnail_cache_dir

    def resolve_path(self, path: str | None) -> str | None:
        """Expand ~ and resolve the attachment path.

        Returns None if path is None or file doesn't exist.
        """
        if not path:
            return None
        expanded = os.path.expanduser(path)
        if not os.path.exists(expanded):
            return None
        return expanded

    def get_thumbnail_path(self, attachment_id: int, size: int = 300) -> str:
        """Get the path for a cached thumbnail."""
        return os.path.join(self.thumbnail_cache_dir, f"{attachment_id}_{size}.jpg")

    def thumbnail_exists(self, attachment_id: int, size: int = 300) -> bool:
        """Check if a thumbnail is already cached."""
        return os.path.exists(self.get_thumbnail_path(attachment_id, size))

    def generate_thumbnail(self, source_path: str, attachment_id: int, size: int = 300) -> str:
        """Generate a thumbnail for an image attachment.

        Returns path to the generated thumbnail.
        Raises ImportError if PIL not available.
        Raises Exception on PIL processing errors.
        """
        from PIL import Image

        # Ensure cache directory exists
        os.makedirs(self.thumbnail_cache_dir, exist_ok=True)

        thumbnail_path = self.get_thumbnail_path(attachment_id, size)

        with Image.open(source_path) as img:
            # Convert to RGB if necessary (HEIC, PNG with transparency, etc.)
            if img.mode != "RGB":
                img = img.convert("RGB")

            # Resize maintaining aspect ratio
            img.thumbnail((size, size), Image.Resampling.LANCZOS)
            img.save(thumbnail_path, "JPEG", quality=85)

        return thumbnail_path
