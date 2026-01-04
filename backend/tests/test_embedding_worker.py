"""Tests for embedding worker module."""

from unittest.mock import MagicMock, patch

import numpy as np

from tests.conftest import MockPendingEmbedding, MockStoredEmbedding


class TestCosignSimilarity:
    """Tests for cosine_similarity function."""

    def test_identical_vectors(self):
        """Identical vectors have similarity 1.0."""
        from embedding_worker import cosine_similarity

        vec = np.array([1.0, 2.0, 3.0])
        result = cosine_similarity(vec, vec)
        assert abs(result - 1.0) < 1e-6

    def test_orthogonal_vectors(self):
        """Orthogonal vectors have similarity 0.0."""
        from embedding_worker import cosine_similarity

        vec1 = np.array([1.0, 0.0, 0.0])
        vec2 = np.array([0.0, 1.0, 0.0])
        result = cosine_similarity(vec1, vec2)
        assert abs(result) < 1e-6

    def test_opposite_vectors(self):
        """Opposite vectors have similarity -1.0."""
        from embedding_worker import cosine_similarity

        vec1 = np.array([1.0, 2.0, 3.0])
        vec2 = np.array([-1.0, -2.0, -3.0])
        result = cosine_similarity(vec1, vec2)
        assert abs(result - (-1.0)) < 1e-6

    def test_similar_vectors(self):
        """Similar vectors have high similarity."""
        from embedding_worker import cosine_similarity

        vec1 = np.array([1.0, 2.0, 3.0])
        vec2 = np.array([1.1, 2.1, 3.1])
        result = cosine_similarity(vec1, vec2)
        assert result > 0.99


class TestProcessEmbeddingQueue:
    """Tests for process_embedding_queue function."""

    def test_process_empty_queue(self):
        """Processing empty queue returns 0."""
        mock_db = MagicMock()
        mock_db.get_pending_embeddings.return_value = []

        with (
            patch("embedding_worker.core.AppDb", return_value=mock_db),
            patch("embedding_worker.APP_DB_PATH", "/fake/path"),
        ):
            from embedding_worker import process_embedding_queue

            result = process_embedding_queue(batch_size=10)
            assert result == 0

    def test_process_messages_with_text(self):
        """Processing messages with text generates embeddings."""
        mock_db = MagicMock()
        mock_db.get_pending_embeddings.return_value = [
            MockPendingEmbedding(id=1, chat_id=1, text="Hello world"),
            MockPendingEmbedding(id=2, chat_id=1, text="Goodbye world"),
        ]

        mock_model = MagicMock()
        mock_model.encode.return_value = np.array(
            [
                [0.1] * 384,
                [0.2] * 384,
            ],
            dtype=np.float32,
        )

        with (
            patch("embedding_worker.core.AppDb", return_value=mock_db),
            patch("embedding_worker.APP_DB_PATH", "/fake/path"),
            patch("embedding_worker.get_model", return_value=mock_model),
        ):
            from embedding_worker import process_embedding_queue

            result = process_embedding_queue(batch_size=10)
            assert result == 2
            assert mock_db.insert_embedding.call_count == 2
            assert mock_db.mark_embedding_complete.call_count == 2

    def test_process_skips_empty_text(self):
        """Processing skips messages with empty text."""
        mock_db = MagicMock()
        mock_db.get_pending_embeddings.return_value = [
            MockPendingEmbedding(id=1, chat_id=1, text="Hello world"),
            MockPendingEmbedding(id=2, chat_id=1, text=""),  # Empty
            MockPendingEmbedding(id=3, chat_id=1, text=None),  # None
            MockPendingEmbedding(id=4, chat_id=1, text="   "),  # Whitespace only
        ]

        mock_model = MagicMock()
        mock_model.encode.return_value = np.array(
            [
                [0.1] * 384,
            ],
            dtype=np.float32,
        )

        with (
            patch("embedding_worker.core.AppDb", return_value=mock_db),
            patch("embedding_worker.APP_DB_PATH", "/fake/path"),
            patch("embedding_worker.get_model", return_value=mock_model),
        ):
            from embedding_worker import process_embedding_queue

            result = process_embedding_queue(batch_size=10)
            assert result == 1  # Only "Hello world" processed


class TestEncodeQuery:
    """Tests for encode_query function."""

    def test_encode_query_returns_numpy_array(self):
        """encode_query returns numpy array."""
        mock_model = MagicMock()
        mock_model.encode.return_value = np.array([0.1] * 384, dtype=np.float32)

        with patch("embedding_worker.get_model", return_value=mock_model):
            from embedding_worker import encode_query

            result = encode_query("test query")
            assert isinstance(result, np.ndarray)
            mock_model.encode.assert_called_with("test query", convert_to_numpy=True)


class TestSemanticSearch:
    """Tests for semantic_search function."""

    def test_semantic_search_empty_embeddings(self):
        """Semantic search with no embeddings returns empty list."""
        mock_db = MagicMock()
        mock_db.get_all_embeddings.return_value = []

        with (
            patch("embedding_worker.core.AppDb", return_value=mock_db),
            patch("embedding_worker.APP_DB_PATH", "/fake/path"),
        ):
            from embedding_worker import semantic_search

            results = semantic_search("test query")
            assert results == []

    def test_semantic_search_returns_sorted_results(self):
        """Semantic search returns results sorted by similarity."""
        mock_db = MagicMock()

        # Create orthogonal embeddings for clear similarity differences
        # embedding1: unit vector along first axis [1, 0, 0, 0, ...]
        vec1 = np.zeros(384, dtype=np.float32)
        vec1[0] = 1.0
        embedding1 = vec1.tobytes()

        # embedding2: unit vector along second axis [0, 1, 0, 0, ...]
        vec2 = np.zeros(384, dtype=np.float32)
        vec2[1] = 1.0
        embedding2 = vec2.tobytes()

        mock_db.get_all_embeddings.return_value = [
            MockStoredEmbedding(message_id=1, chat_id=1, embedding=embedding1),
            MockStoredEmbedding(message_id=2, chat_id=1, embedding=embedding2),
        ]

        mock_model = MagicMock()
        # Query embedding similar to embedding2 (along second axis)
        query_vec = np.zeros(384, dtype=np.float32)
        query_vec[1] = 1.0
        mock_model.encode.return_value = query_vec

        with (
            patch("embedding_worker.core.AppDb", return_value=mock_db),
            patch("embedding_worker.APP_DB_PATH", "/fake/path"),
            patch("embedding_worker.get_model", return_value=mock_model),
        ):
            from embedding_worker import semantic_search

            results = semantic_search("test query", limit=10)

            assert len(results) == 2
            # Results should be sorted by similarity (descending)
            assert results[0]["similarity"] >= results[1]["similarity"]
            # message_id=2 should be first (more similar to query along axis 1)
            assert results[0]["message_id"] == 2
            # First result should have similarity ~1.0, second ~0.0
            assert results[0]["similarity"] > 0.9
            assert results[1]["similarity"] < 0.1

    def test_semantic_search_respects_limit(self):
        """Semantic search respects limit parameter."""
        mock_db = MagicMock()

        embeddings = []
        for i in range(10):
            embedding = np.array([0.1 * i] * 384, dtype=np.float32).tobytes()
            embeddings.append(MockStoredEmbedding(message_id=i, chat_id=1, embedding=embedding))

        mock_db.get_all_embeddings.return_value = embeddings

        mock_model = MagicMock()
        mock_model.encode.return_value = np.array([0.5] * 384, dtype=np.float32)

        with (
            patch("embedding_worker.core.AppDb", return_value=mock_db),
            patch("embedding_worker.APP_DB_PATH", "/fake/path"),
            patch("embedding_worker.get_model", return_value=mock_model),
        ):
            from embedding_worker import semantic_search

            results = semantic_search("test", limit=3)
            assert len(results) == 3


class TestQueueAllMessages:
    """Tests for queue_all_messages function."""

    def test_queue_all_messages(self):
        """Queue all messages for embedding."""
        mock_db = MagicMock()
        mock_db.queue_all_messages_for_embedding.return_value = 1000

        with (
            patch("embedding_worker.core.AppDb", return_value=mock_db),
            patch("embedding_worker.APP_DB_PATH", "/fake/path"),
        ):
            from embedding_worker import queue_all_messages

            result = queue_all_messages()
            assert result == 1000
            mock_db.queue_all_messages_for_embedding.assert_called_once()


class TestGetQueueStats:
    """Tests for get_queue_stats function."""

    def test_get_queue_stats(self):
        """Get queue statistics."""
        mock_db = MagicMock()
        mock_db.get_embedding_queue_stats.return_value = (100, 500, 500)

        with (
            patch("embedding_worker.core.AppDb", return_value=mock_db),
            patch("embedding_worker.APP_DB_PATH", "/fake/path"),
        ):
            from embedding_worker import get_queue_stats

            stats = get_queue_stats()
            assert stats["pending"] == 100
            assert stats["completed"] == 500
            assert stats["total_embeddings"] == 500


class TestGetModel:
    """Tests for get_model function (lazy loading)."""

    def test_model_lazy_loaded(self):
        """Model is loaded lazily on first use."""
        import embedding_worker

        # Reset the global _model
        original_model = embedding_worker._model
        embedding_worker._model = None

        mock_transformer = MagicMock()

        try:
            # Patch at the point of import in the function
            with patch.object(
                embedding_worker,
                "SentenceTransformer",
                return_value=mock_transformer,
                create=True,
            ):
                # Also need to patch the import inside the function
                mock_st_module = MagicMock(
                    SentenceTransformer=MagicMock(return_value=mock_transformer)
                )
                with patch.dict(
                    "sys.modules",
                    {"sentence_transformers": mock_st_module},
                ):
                    # Force reimport to pick up our mock
                    with patch(
                        "sentence_transformers.SentenceTransformer",
                        return_value=mock_transformer,
                    ):
                        model = embedding_worker.get_model()
                        assert model == mock_transformer

                        # Second call should return cached model
                        model2 = embedding_worker.get_model()
                        assert model2 == mock_transformer
        finally:
            # Clean up
            embedding_worker._model = original_model

    def test_model_caching(self):
        """Model is cached after first load."""
        import embedding_worker

        original_model = embedding_worker._model

        try:
            # Set a mock model
            mock_model = MagicMock()
            embedding_worker._model = mock_model

            # Should return cached model without loading
            result = embedding_worker.get_model()
            assert result == mock_model
        finally:
            embedding_worker._model = original_model
