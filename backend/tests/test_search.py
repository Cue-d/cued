"""Tests for search router endpoints."""

from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient

from tests.conftest import MockPrmChat, MockSearchResult


class TestFullTextSearch:
    """Tests for GET /search endpoint."""

    def test_search_messages(self, client: TestClient, mock_app_db: MagicMock):
        """Search messages returns results."""
        response = client.get("/search/?query=hello")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
        assert len(data) == 1

    def test_search_messages_structure(self, client: TestClient):
        """Search result has correct structure."""
        response = client.get("/search/?query=hello")
        data = response.json()
        result = data[0]

        assert result["message_id"] == 1
        assert result["chat_id"] == 1
        assert result["text"] == "Hello!"
        assert result["timestamp"] == 700000000
        assert result["sender_name"] == "John Doe"
        assert result["chat_name"] == "John Doe"
        assert result["rank"] == 1.5

    def test_search_messages_with_limit(self, client: TestClient, mock_app_db: MagicMock):
        """Search with limit parameter."""
        response = client.get("/search/?query=hello&limit=10")
        assert response.status_code == 200
        mock_app_db.search_messages.assert_called_with("hello", 10)

    def test_search_messages_filter_by_chat(self, client: TestClient, mock_app_db: MagicMock):
        """Search with chat_id filter."""
        # Add results from multiple chats
        mock_app_db.search_messages.return_value = [
            MockSearchResult(
                message_id=1,
                chat_id=1,
                text="Hello!",
                timestamp=700000000,
                sender_name="John Doe",
                chat_name="John Doe",
                rank=1.5,
            ),
            MockSearchResult(
                message_id=2,
                chat_id=2,
                text="Hello there!",
                timestamp=700000001,
                sender_name="Jane Smith",
                chat_name="Family Group",
                rank=1.0,
            ),
        ]

        response = client.get("/search/?query=hello&chat_id=1")
        assert response.status_code == 200
        data = response.json()
        assert len(data) == 1
        assert data[0]["chat_id"] == 1

    def test_search_messages_empty_results(self, client: TestClient, mock_app_db: MagicMock):
        """Search with no results."""
        mock_app_db.search_messages.return_value = []

        response = client.get("/search/?query=nonexistent")
        assert response.status_code == 200
        data = response.json()
        assert data == []


class TestRebuildSearchIndex:
    """Tests for POST /search/rebuild endpoint."""

    def test_rebuild_search_index(self, client: TestClient, mock_app_db: MagicMock):
        """Rebuild FTS index returns count."""
        response = client.post("/search/rebuild")
        assert response.status_code == 200
        data = response.json()
        assert data["success"] is True
        assert data["messages_indexed"] == 100
        mock_app_db.rebuild_fts_index.assert_called_once()


class TestSemanticSearch:
    """Tests for GET /search/semantic endpoint."""

    def test_semantic_search(self, client: TestClient, mock_app_db: MagicMock):
        """Semantic search returns results."""
        mock_app_db.get_chat.return_value = MockPrmChat(
            id=1,
            identifier="+11234567890",
            name="John Doe",
            is_group=False,
            last_message_text="Hello!",
            last_message_timestamp=700000000,
        )

        with patch("routers.search.semantic_search") as mock_semantic:
            mock_semantic.return_value = [
                {"message_id": 1, "chat_id": 1, "similarity": 0.95},
            ]

            response = client.get("/search/semantic?query=greeting")
            assert response.status_code == 200
            data = response.json()
            assert isinstance(data, list)

    def test_semantic_search_worker_not_available(self, client: TestClient):
        """Semantic search handles missing worker gracefully."""
        import builtins
        import sys

        # Remove cached module so the import is attempted fresh
        sys.modules.pop("embedding_worker", None)

        original_import = builtins.__import__

        def mock_import(name, *args, **kwargs):
            if name == "embedding_worker":
                raise ImportError("No module named 'embedding_worker'")
            return original_import(name, *args, **kwargs)

        with patch.object(builtins, "__import__", mock_import):
            response = client.get("/search/semantic?query=test")
            assert response.status_code == 200
            assert response.json() == []


class TestEmbeddingsQueueAll:
    """Tests for POST /search/embeddings/queue-all endpoint."""

    def test_queue_all_embeddings(self, client: TestClient):
        """Queue all messages for embedding."""
        with patch("embedding_worker.queue_all_messages") as mock_queue:
            mock_queue.return_value = 1000

            response = client.post("/search/embeddings/queue-all")
            assert response.status_code == 200
            data = response.json()
            assert data["success"] is True
            assert data["messages_queued"] == 1000

    def test_queue_all_embeddings_worker_not_available(self, client: TestClient):
        """Queue all handles missing worker gracefully."""
        import builtins
        import sys

        # Remove cached module so the import is attempted fresh
        sys.modules.pop("embedding_worker", None)

        original_import = builtins.__import__

        def mock_import(name, *args, **kwargs):
            if name == "embedding_worker":
                raise ImportError("No module named 'embedding_worker'")
            return original_import(name, *args, **kwargs)

        with patch.object(builtins, "__import__", mock_import):
            response = client.post("/search/embeddings/queue-all")
            assert response.status_code == 200
            data = response.json()
            assert data["success"] is False
            assert "not available" in data["error"]


class TestEmbeddingsProcess:
    """Tests for POST /search/embeddings/process endpoint."""

    def test_process_embeddings(self, client: TestClient):
        """Process pending embeddings."""
        with patch("embedding_worker.process_embedding_queue") as mock_process:
            mock_process.return_value = 50

            response = client.post("/search/embeddings/process")
            assert response.status_code == 200
            data = response.json()
            assert data["success"] is True
            assert data["processed"] == 50

    def test_process_embeddings_with_batch_size(self, client: TestClient):
        """Process embeddings with custom batch size."""
        with patch("embedding_worker.process_embedding_queue") as mock_process:
            mock_process.return_value = 200

            response = client.post("/search/embeddings/process?batch_size=200")
            assert response.status_code == 200
            mock_process.assert_called_with(200)


class TestEmbeddingsStats:
    """Tests for GET /search/embeddings/stats endpoint."""

    def test_get_embedding_stats(self, client: TestClient):
        """Get embedding queue statistics."""
        with patch("embedding_worker.get_queue_stats") as mock_stats:
            mock_stats.return_value = {
                "pending": 100,
                "completed": 500,
                "total_embeddings": 500,
            }

            response = client.get("/search/embeddings/stats")
            assert response.status_code == 200
            data = response.json()
            assert data["pending"] == 100
            assert data["completed"] == 500
            assert data["total_embeddings"] == 500

    def test_get_embedding_stats_worker_not_available(self, client: TestClient):
        """Get stats handles errors gracefully."""
        with patch("embedding_worker.get_queue_stats", side_effect=Exception("Test error")):
            response = client.get("/search/embeddings/stats")
            assert response.status_code == 200
            data = response.json()
            assert data["pending"] == 0
            assert "error" in data
