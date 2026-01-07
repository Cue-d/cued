"""Tests for attachments router."""

import os
import tempfile
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient


class MockAttachment:
    """Mock attachment object returned from AppDb."""

    def __init__(
        self,
        id: int,
        path: str | None,
        mime_type: str | None,
        filename: str | None = None,
    ):
        self.id = id
        self.path = path
        self.mime_type = mime_type
        self.filename = filename
        self.message_id = 1
        self.uti = None
        self.size = 1024
        self.is_outgoing = False
        self.created_at = None


@pytest.fixture
def temp_image_file():
    """Create a temporary image file for testing."""
    # Create a minimal valid JPEG file (smallest valid JPEG)
    jpeg_data = bytes(
        [
            0xFF,
            0xD8,
            0xFF,
            0xE0,
            0x00,
            0x10,
            0x4A,
            0x46,
            0x49,
            0x46,
            0x00,
            0x01,
            0x01,
            0x00,
            0x00,
            0x01,
            0x00,
            0x01,
            0x00,
            0x00,
            0xFF,
            0xDB,
            0x00,
            0x43,
            0x00,
            0x08,
            0x06,
            0x06,
            0x07,
            0x06,
            0x05,
            0x08,
            0x07,
            0x07,
            0x07,
            0x09,
            0x09,
            0x08,
            0x0A,
            0x0C,
            0x14,
            0x0D,
            0x0C,
            0x0B,
            0x0B,
            0x0C,
            0x19,
            0x12,
            0x13,
            0x0F,
            0x14,
            0x1D,
            0x1A,
            0x1F,
            0x1E,
            0x1D,
            0x1A,
            0x1C,
            0x1C,
            0x20,
            0x24,
            0x2E,
            0x27,
            0x20,
            0x22,
            0x2C,
            0x23,
            0x1C,
            0x1C,
            0x28,
            0x37,
            0x29,
            0x2C,
            0x30,
            0x31,
            0x34,
            0x34,
            0x34,
            0x1F,
            0x27,
            0x39,
            0x3D,
            0x38,
            0x32,
            0x3C,
            0x2E,
            0x33,
            0x34,
            0x32,
            0xFF,
            0xC0,
            0x00,
            0x0B,
            0x08,
            0x00,
            0x01,
            0x00,
            0x01,
            0x01,
            0x01,
            0x11,
            0x00,
            0xFF,
            0xC4,
            0x00,
            0x1F,
            0x00,
            0x00,
            0x01,
            0x05,
            0x01,
            0x01,
            0x01,
            0x01,
            0x01,
            0x01,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x01,
            0x02,
            0x03,
            0x04,
            0x05,
            0x06,
            0x07,
            0x08,
            0x09,
            0x0A,
            0x0B,
            0xFF,
            0xC4,
            0x00,
            0xB5,
            0x10,
            0x00,
            0x02,
            0x01,
            0x03,
            0x03,
            0x02,
            0x04,
            0x03,
            0x05,
            0x05,
            0x04,
            0x04,
            0x00,
            0x00,
            0x01,
            0x7D,
            0x01,
            0x02,
            0x03,
            0x00,
            0x04,
            0x11,
            0x05,
            0x12,
            0x21,
            0x31,
            0x41,
            0x06,
            0x13,
            0x51,
            0x61,
            0x07,
            0x22,
            0x71,
            0x14,
            0x32,
            0x81,
            0x91,
            0xA1,
            0x08,
            0x23,
            0x42,
            0xB1,
            0xC1,
            0x15,
            0x52,
            0xD1,
            0xF0,
            0x24,
            0x33,
            0x62,
            0x72,
            0x82,
            0x09,
            0x0A,
            0x16,
            0x17,
            0x18,
            0x19,
            0x1A,
            0x25,
            0x26,
            0x27,
            0x28,
            0x29,
            0x2A,
            0x34,
            0x35,
            0x36,
            0x37,
            0x38,
            0x39,
            0x3A,
            0x43,
            0x44,
            0x45,
            0x46,
            0x47,
            0x48,
            0x49,
            0x4A,
            0x53,
            0x54,
            0x55,
            0x56,
            0x57,
            0x58,
            0x59,
            0x5A,
            0x63,
            0x64,
            0x65,
            0x66,
            0x67,
            0x68,
            0x69,
            0x6A,
            0x73,
            0x74,
            0x75,
            0x76,
            0x77,
            0x78,
            0x79,
            0x7A,
            0x83,
            0x84,
            0x85,
            0x86,
            0x87,
            0x88,
            0x89,
            0x8A,
            0x92,
            0x93,
            0x94,
            0x95,
            0x96,
            0x97,
            0x98,
            0x99,
            0x9A,
            0xA2,
            0xA3,
            0xA4,
            0xA5,
            0xA6,
            0xA7,
            0xA8,
            0xA9,
            0xAA,
            0xB2,
            0xB3,
            0xB4,
            0xB5,
            0xB6,
            0xB7,
            0xB8,
            0xB9,
            0xBA,
            0xC2,
            0xC3,
            0xC4,
            0xC5,
            0xC6,
            0xC7,
            0xC8,
            0xC9,
            0xCA,
            0xD2,
            0xD3,
            0xD4,
            0xD5,
            0xD6,
            0xD7,
            0xD8,
            0xD9,
            0xDA,
            0xE1,
            0xE2,
            0xE3,
            0xE4,
            0xE5,
            0xE6,
            0xE7,
            0xE8,
            0xE9,
            0xEA,
            0xF1,
            0xF2,
            0xF3,
            0xF4,
            0xF5,
            0xF6,
            0xF7,
            0xF8,
            0xF9,
            0xFA,
            0xFF,
            0xDA,
            0x00,
            0x08,
            0x01,
            0x01,
            0x00,
            0x00,
            0x3F,
            0x00,
            0xFB,
            0xD5,
            0xDB,
            0x20,
            0xA8,
            0xF1,
            0x5E,
            0xFF,
            0xD9,
        ]
    )

    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as f:
        f.write(jpeg_data)
        temp_path = f.name

    yield temp_path

    # Cleanup
    if os.path.exists(temp_path):
        os.unlink(temp_path)


class TestGetAttachmentFile:
    """Tests for GET /attachments/{id}/file endpoint."""

    def test_returns_404_when_attachment_not_found(self, client: TestClient):
        """Returns 404 when attachment doesn't exist."""
        response = client.get("/attachments/99999/file")
        assert response.status_code == 404
        assert response.json()["detail"] == "Attachment not found"

    def test_returns_404_when_path_is_none(self, client: TestClient):
        """Returns 404 when attachment has no path."""
        mock_attachment = MockAttachment(id=1, path=None, mime_type="image/jpeg")

        with patch("routers.attachments.get_app_db") as mock_db:
            mock_db.return_value.get_attachment.return_value = mock_attachment
            response = client.get("/attachments/1/file")

        assert response.status_code == 404
        assert response.json()["detail"] == "Attachment path not available"

    def test_returns_404_when_file_not_on_disk(self, client: TestClient):
        """Returns 404 when file doesn't exist on disk."""
        mock_attachment = MockAttachment(
            id=1, path="/nonexistent/path/file.jpg", mime_type="image/jpeg"
        )

        with patch("routers.attachments.get_app_db") as mock_db:
            mock_db.return_value.get_attachment.return_value = mock_attachment
            response = client.get("/attachments/1/file")

        assert response.status_code == 404
        assert response.json()["detail"] == "Attachment file not found on disk"

    def test_returns_file_when_exists(self, client: TestClient, temp_image_file: str):
        """Returns file content when attachment exists."""
        mock_attachment = MockAttachment(
            id=1, path=temp_image_file, mime_type="image/jpeg", filename="test.jpg"
        )

        with patch("routers.attachments.get_app_db") as mock_db:
            mock_db.return_value.get_attachment.return_value = mock_attachment
            response = client.get("/attachments/1/file")

        assert response.status_code == 200
        assert response.headers["content-type"] == "image/jpeg"


class TestGetAttachmentThumbnail:
    """Tests for GET /attachments/{id}/thumbnail endpoint."""

    def test_returns_404_when_attachment_not_found(self, client: TestClient):
        """Returns 404 when attachment doesn't exist."""
        response = client.get("/attachments/99999/thumbnail")
        assert response.status_code == 404
        assert response.json()["detail"] == "Attachment not found"

    def test_returns_400_when_not_image(self, client: TestClient):
        """Returns 400 when attachment is not an image."""
        mock_attachment = MockAttachment(
            id=1, path="/some/path/doc.pdf", mime_type="application/pdf"
        )

        with patch("routers.attachments.get_app_db") as mock_db:
            mock_db.return_value.get_attachment.return_value = mock_attachment
            response = client.get("/attachments/1/thumbnail")

        assert response.status_code == 400
        assert response.json()["detail"] == "Attachment is not an image"

    def test_returns_404_when_image_file_not_on_disk(self, client: TestClient):
        """Returns 404 when image file doesn't exist on disk."""
        mock_attachment = MockAttachment(
            id=1, path="/nonexistent/path/image.jpg", mime_type="image/jpeg"
        )

        with patch("routers.attachments.get_app_db") as mock_db:
            mock_db.return_value.get_attachment.return_value = mock_attachment
            response = client.get("/attachments/1/thumbnail")

        assert response.status_code == 404
        assert response.json()["detail"] == "Attachment file not found on disk"
