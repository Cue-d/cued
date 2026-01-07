"""Tests for shared utility functions."""

from utils import is_image_mime_type


class TestIsImageMimeType:
    """Tests for is_image_mime_type function."""

    def test_returns_true_for_jpeg(self):
        assert is_image_mime_type("image/jpeg") is True

    def test_returns_true_for_png(self):
        assert is_image_mime_type("image/png") is True

    def test_returns_true_for_gif(self):
        assert is_image_mime_type("image/gif") is True

    def test_returns_true_for_heic(self):
        assert is_image_mime_type("image/heic") is True

    def test_returns_true_for_webp(self):
        assert is_image_mime_type("image/webp") is True

    def test_returns_false_for_pdf(self):
        assert is_image_mime_type("application/pdf") is False

    def test_returns_false_for_text(self):
        assert is_image_mime_type("text/plain") is False

    def test_returns_false_for_video(self):
        assert is_image_mime_type("video/mp4") is False

    def test_returns_false_for_audio(self):
        assert is_image_mime_type("audio/mpeg") is False

    def test_returns_false_for_none(self):
        assert is_image_mime_type(None) is False

    def test_returns_false_for_empty_string(self):
        assert is_image_mime_type("") is False
