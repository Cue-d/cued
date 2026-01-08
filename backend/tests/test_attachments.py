"""Tests for attachments service and router."""

import os
import tempfile

import pytest

from services.attachments import AttachmentService, is_image_mime_type


class TestIsImageMimeType:
    """Tests for is_image_mime_type helper."""

    def test_returns_true_for_image_types(self):
        assert is_image_mime_type("image/jpeg") is True
        assert is_image_mime_type("image/png") is True
        assert is_image_mime_type("image/heic") is True
        assert is_image_mime_type("image/gif") is True

    def test_returns_false_for_non_image_types(self):
        assert is_image_mime_type("application/pdf") is False
        assert is_image_mime_type("text/plain") is False
        assert is_image_mime_type("video/mp4") is False

    def test_returns_false_for_none(self):
        assert is_image_mime_type(None) is False

    def test_returns_false_for_empty_string(self):
        assert is_image_mime_type("") is False


class TestAttachmentService:
    """Tests for AttachmentService class."""

    def test_resolve_path_returns_none_for_none(self):
        service = AttachmentService()
        assert service.resolve_path(None) is None

    def test_resolve_path_returns_none_for_nonexistent(self):
        service = AttachmentService()
        assert service.resolve_path("/nonexistent/path/file.jpg") is None

    def test_resolve_path_returns_expanded_path_for_existing_file(self):
        service = AttachmentService()
        # Create a temp file to test with
        with tempfile.NamedTemporaryFile(delete=False) as f:
            temp_path = f.name
        try:
            result = service.resolve_path(temp_path)
            assert result == temp_path
        finally:
            os.unlink(temp_path)

    def test_get_thumbnail_path(self):
        service = AttachmentService("/tmp/thumbnails")
        path = service.get_thumbnail_path(123, 300)
        assert path == "/tmp/thumbnails/123_300.jpg"

    def test_get_thumbnail_path_default_size(self):
        service = AttachmentService("/tmp/thumbnails")
        path = service.get_thumbnail_path(456)
        assert path == "/tmp/thumbnails/456_300.jpg"

    def test_thumbnail_exists_returns_false_for_nonexistent(self):
        service = AttachmentService("/tmp/nonexistent_thumbnails")
        assert service.thumbnail_exists(123, 300) is False

    def test_thumbnail_exists_returns_true_for_existing(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            service = AttachmentService(tmpdir)
            # Create a fake thumbnail file
            thumbnail_path = os.path.join(tmpdir, "123_300.jpg")
            with open(thumbnail_path, "w") as f:
                f.write("fake thumbnail")
            assert service.thumbnail_exists(123, 300) is True


class TestAttachmentServiceThumbnailGeneration:
    """Tests for thumbnail generation (requires PIL)."""

    @pytest.fixture
    def temp_image_path(self) -> str:
        """Create a temporary test image."""
        try:
            from PIL import Image
        except ImportError:
            pytest.skip("PIL not available")

        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
            img = Image.new("RGB", (100, 100), color="red")
            img.save(f.name, "PNG")
            yield f.name
            os.unlink(f.name)

    def test_generate_thumbnail_creates_file(self, temp_image_path):
        with tempfile.TemporaryDirectory() as tmpdir:
            service = AttachmentService(tmpdir)
            thumbnail_path = service.generate_thumbnail(temp_image_path, 999, 50)
            assert os.path.exists(thumbnail_path)
            assert thumbnail_path == os.path.join(tmpdir, "999_50.jpg")

    def test_generate_thumbnail_creates_cache_directory(self, temp_image_path):
        with tempfile.TemporaryDirectory() as tmpdir:
            cache_dir = os.path.join(tmpdir, "nested", "cache")
            service = AttachmentService(cache_dir)
            thumbnail_path = service.generate_thumbnail(temp_image_path, 888, 50)
            assert os.path.exists(cache_dir)
            assert os.path.exists(thumbnail_path)
