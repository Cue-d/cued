"""Tests for search services."""

import os

import numpy as np
import pytest

from db import AppDb, sync_all
from services.search import (
    EmbeddingDb,
    FtsIndex,
    SearchResult,
    merge_results,
    process_queue,
    queue_all_messages,
    reciprocal_rank_fusion,
    semantic_search,
)


@pytest.fixture
def embedding_db_path(temp_dir: str) -> str:
    """Return path for test embeddings.db."""
    return os.path.join(temp_dir, "embeddings.db")


@pytest.fixture
def embedding_db(embedding_db_path: str):
    """Create an EmbeddingDb instance with initialized schema."""
    db = EmbeddingDb(embedding_db_path)
    db.init_schema()
    yield db


@pytest.fixture
def synced_app_db(chat_db_path: str, app_db_path: str):
    """Create an AppDb with synced data from chat.db."""
    sync_all(chat_db_path, app_db_path, verbose=False)
    db = AppDb(app_db_path)
    yield db
    db.close()


@pytest.fixture
def fts_index(synced_app_db: AppDb):
    """Create an FtsIndex with initialized and rebuilt index."""
    fts = FtsIndex(synced_app_db.engine)
    fts.init()
    fts.rebuild()
    return fts


# =============================================================================
# FtsIndex Tests
# =============================================================================


class TestFtsIndex:
    """Tests for FTS5 full-text search."""

    def test_init_creates_fts_table(self, synced_app_db: AppDb):
        """init() creates the messages_fts virtual table."""
        fts = FtsIndex(synced_app_db.engine)
        fts.init()

        with synced_app_db.engine.connect() as conn:
            from sqlmodel import text

            result = conn.execute(
                text("SELECT name FROM sqlite_master WHERE type='table' AND name='messages_fts'")
            )
            assert result.fetchone() is not None

    def test_rebuild_indexes_messages(self, synced_app_db: AppDb):
        """rebuild() indexes all messages with text."""
        fts = FtsIndex(synced_app_db.engine)
        fts.init()
        count = fts.rebuild()

        # We have 3 messages in the fixture
        assert count == 3

    def test_rebuild_handles_corruption(self, synced_app_db: AppDb):
        """rebuild() can recover from corrupted index by dropping and recreating."""
        fts = FtsIndex(synced_app_db.engine)
        fts.init()
        fts.rebuild()

        # Rebuild again should work (drops and recreates)
        count = fts.rebuild()
        assert count == 3

    def test_search_finds_exact_match(self, fts_index: FtsIndex):
        """search() finds messages with exact word match."""
        results = fts_index.search("Hello")

        assert len(results) >= 1
        assert any("Hello" in r.text for r in results)

    def test_search_finds_stemmed_match(self, fts_index: FtsIndex):
        """search() finds messages with stemmed words (porter tokenizer)."""
        # "tomorrow" should match "tomorrow" via stemming
        results = fts_index.search("tomorrow")

        assert len(results) >= 1
        assert any("tomorrow" in r.text.lower() for r in results)

    def test_search_returns_search_results(self, fts_index: FtsIndex):
        """search() returns SearchResult objects with all fields."""
        results = fts_index.search("Hello")

        assert len(results) >= 1
        result = results[0]
        assert isinstance(result, SearchResult)
        assert result.message_id > 0
        assert result.chat_id > 0
        assert result.text
        assert result.timestamp > 0
        assert result.rank is not None

    def test_search_respects_limit(self, fts_index: FtsIndex):
        """search() respects the limit parameter."""
        results = fts_index.search("Hello", limit=1)

        assert len(results) <= 1

    def test_search_orders_by_bm25(self, fts_index: FtsIndex):
        """search() orders results by BM25 rank."""
        results = fts_index.search("Hello", limit=10)

        if len(results) > 1:
            # Lower BM25 scores are better (more relevant)
            ranks = [r.rank for r in results]
            assert ranks == sorted(ranks)

    def test_search_no_results(self, fts_index: FtsIndex):
        """search() returns empty list for no matches."""
        results = fts_index.search("xyznonexistent123")

        assert results == []


# =============================================================================
# EmbeddingDb Tests
# =============================================================================


class TestEmbeddingDb:
    """Tests for EmbeddingDb class."""

    def test_init_schema_creates_tables(self, embedding_db: EmbeddingDb):
        """init_schema() creates required tables."""
        with embedding_db.session() as session:
            from sqlmodel import text

            result = session.execute(
                text("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            )
            tables = [row[0] for row in result]

        assert "embedding_queue" in tables
        assert "message_embeddings" in tables

    def test_queue_messages(self, embedding_db: EmbeddingDb):
        """queue_messages() adds messages to queue."""
        messages = [(1, 10), (2, 10), (3, 20)]
        count = embedding_db.queue_messages(messages)

        assert count == 3
        stats = embedding_db.get_stats()
        assert stats["pending"] == 3

    def test_queue_messages_empty(self, embedding_db: EmbeddingDb):
        """queue_messages() handles empty list."""
        count = embedding_db.queue_messages([])

        assert count == 0

    def test_queue_messages_ignores_duplicates(self, embedding_db: EmbeddingDb):
        """queue_messages() ignores duplicate message_ids."""
        embedding_db.queue_messages([(1, 10)])
        embedding_db.queue_messages([(1, 10)])  # duplicate

        stats = embedding_db.get_stats()
        assert stats["pending"] == 1

    def test_get_pending(self, embedding_db: EmbeddingDb):
        """get_pending() returns pending messages."""
        embedding_db.queue_messages([(1, 10), (2, 20)])

        pending = embedding_db.get_pending(limit=10)

        assert len(pending) == 2
        assert (1, 10) in pending
        assert (2, 20) in pending

    def test_get_pending_respects_limit(self, embedding_db: EmbeddingDb):
        """get_pending() respects limit parameter."""
        embedding_db.queue_messages([(1, 10), (2, 20), (3, 30)])

        pending = embedding_db.get_pending(limit=2)

        assert len(pending) == 2

    def test_insert_and_get_embedding(self, embedding_db: EmbeddingDb):
        """insert_embedding() and get_all_embeddings() work together."""
        # Create a fake embedding (384 dimensions for all-MiniLM-L6-v2)
        fake_embedding = np.random.rand(384).astype(np.float32).tobytes()

        embedding_db.insert_embedding(1, 10, fake_embedding)

        embeddings = embedding_db.get_all_embeddings()
        assert len(embeddings) == 1
        msg_id, chat_id, blob = embeddings[0]
        assert msg_id == 1
        assert chat_id == 10
        assert blob == fake_embedding

    def test_mark_complete(self, embedding_db: EmbeddingDb):
        """mark_complete() updates status to completed."""
        embedding_db.queue_messages([(1, 10)])
        embedding_db.mark_complete(1)

        stats = embedding_db.get_stats()
        assert stats["pending"] == 0
        assert stats["completed"] == 1

    def test_get_stats(self, embedding_db: EmbeddingDb):
        """get_stats() returns correct counts."""
        embedding_db.queue_messages([(1, 10), (2, 20)])
        embedding_db.mark_complete(1)
        embedding_db.insert_embedding(1, 10, b"fake")

        stats = embedding_db.get_stats()

        assert stats["pending"] == 1
        assert stats["completed"] == 1
        assert stats["total_embeddings"] == 1


# =============================================================================
# Reciprocal Rank Fusion Tests
# =============================================================================


class TestReciprocalRankFusion:
    """Tests for RRF algorithm."""

    def test_fts_only(self):
        """RRF with only FTS results."""
        fts_results = [
            SearchResult(message_id=1, chat_id=10, text="Hello", timestamp=100, rank=-5.0),
            SearchResult(message_id=2, chat_id=10, text="World", timestamp=101, rank=-4.0),
        ]

        merged = reciprocal_rank_fusion(fts_results, [])

        assert len(merged) == 2
        # First result should have higher score
        assert merged[0]["data"]["message_id"] == 1

    def test_semantic_only(self):
        """RRF with only semantic results."""
        semantic_results = [
            {"message_id": 1, "chat_id": 10, "similarity": 0.9},
            {"message_id": 2, "chat_id": 10, "similarity": 0.8},
        ]

        merged = reciprocal_rank_fusion([], semantic_results)

        assert len(merged) == 2
        assert merged[0]["data"]["message_id"] == 1
        assert merged[0].get("needs_fetch") is True

    def test_both_boost_overlapping(self):
        """RRF boosts items appearing in both result sets."""
        fts_results = [
            SearchResult(message_id=1, chat_id=10, text="Hello", timestamp=100, rank=-5.0),
            SearchResult(message_id=2, chat_id=10, text="World", timestamp=101, rank=-4.0),
        ]
        semantic_results = [
            {"message_id=2, chat_id": 10, "similarity": 0.9},  # msg 2 is top semantic
            {"message_id": 1, "chat_id": 10, "similarity": 0.8},  # msg 1 is second
        ]
        # Fix the typo in semantic_results
        semantic_results = [
            {"message_id": 2, "chat_id": 10, "similarity": 0.9},
            {"message_id": 1, "chat_id": 10, "similarity": 0.8},
        ]

        merged = reciprocal_rank_fusion(fts_results, semantic_results)

        # Both messages should have boosted scores since they appear in both
        scores = {m["data"]["message_id"]: m["score"] for m in merged}
        # Score should be sum of RRF from both lists
        # msg 1: 1/(60+1) + 1/(60+2) = ~0.0164 + ~0.0161 = ~0.0325
        # msg 2: 1/(60+2) + 1/(60+1) = ~0.0161 + ~0.0164 = ~0.0325
        assert scores[1] > 0.03
        assert scores[2] > 0.03

    def test_unique_items_from_each_list(self):
        """RRF includes unique items from each list."""
        fts_results = [
            SearchResult(message_id=1, chat_id=10, text="Hello", timestamp=100, rank=-5.0),
        ]
        semantic_results = [
            {"message_id": 2, "chat_id": 10, "similarity": 0.9},
        ]

        merged = reciprocal_rank_fusion(fts_results, semantic_results)

        msg_ids = [m["data"]["message_id"] for m in merged]
        assert 1 in msg_ids
        assert 2 in msg_ids


class TestMergeResults:
    """Tests for merge_results function."""

    def test_empty_inputs(self):
        """merge_results() returns empty for empty inputs."""
        result = merge_results([], [], lambda x: None)

        assert result == []

    def test_normalizes_scores(self):
        """merge_results() normalizes scores to 0-1 range."""
        fts_results = [
            SearchResult(message_id=1, chat_id=10, text="Hello", timestamp=100, rank=-5.0),
            SearchResult(message_id=2, chat_id=10, text="World", timestamp=101, rank=-4.0),
        ]

        results = merge_results(fts_results, [], lambda x: None)

        assert results[0].rank == 1.0  # top result has rank 1.0
        assert 0 < results[1].rank < 1.0

    def test_fetches_missing_text(self):
        """merge_results() fetches text for semantic-only results."""
        semantic_results = [
            {"message_id": 1, "chat_id": 10, "similarity": 0.9},
        ]

        def mock_get_text(msg_id):
            return f"Text for {msg_id}"

        results = merge_results([], semantic_results, mock_get_text)

        assert results[0].text == "Text for 1"

    def test_respects_limit(self):
        """merge_results() respects limit parameter."""
        fts_results = [
            SearchResult(
                message_id=i, chat_id=10, text=f"Msg {i}", timestamp=100 + i, rank=-5.0 - i
            )
            for i in range(10)
        ]

        results = merge_results(fts_results, [], lambda x: None, limit=3)

        assert len(results) == 3

    def test_returns_search_results(self):
        """merge_results() returns SearchResult objects."""
        fts_results = [
            SearchResult(message_id=1, chat_id=10, text="Hello", timestamp=100, rank=-5.0),
        ]

        results = merge_results(fts_results, [], lambda x: None)

        assert len(results) == 1
        assert isinstance(results[0], SearchResult)


# =============================================================================
# Integration Tests (using real embeddings - slower)
# =============================================================================


class TestSemanticSearchIntegration:
    """Integration tests for semantic search (requires model loading)."""

    @pytest.mark.slow
    def test_semantic_search_empty_db(self, embedding_db: EmbeddingDb):
        """semantic_search() returns empty for empty database."""
        results = semantic_search(embedding_db, "hello")

        assert results == []

    @pytest.mark.slow
    def test_semantic_search_finds_similar(self, embedding_db: EmbeddingDb):
        """semantic_search() finds semantically similar messages."""
        from services.search.semantic import get_model

        model = get_model()

        # Insert embeddings for test messages
        texts = ["Hello, how are you?", "What is the weather like?", "Goodbye friend"]
        for i, text in enumerate(texts):
            emb = model.encode(text, convert_to_numpy=True).astype(np.float32).tobytes()
            embedding_db.insert_embedding(i + 1, 10, emb)

        # Search for greeting-like query
        results = semantic_search(embedding_db, "Hi there", limit=3)

        assert len(results) == 3
        # "Hello, how are you?" should be most similar to "Hi there"
        assert results[0]["message_id"] == 1

    @pytest.mark.slow
    def test_process_queue(self, synced_app_db: AppDb, embedding_db: EmbeddingDb):
        """process_queue() processes pending messages."""
        # Queue all messages
        queue_all_messages(synced_app_db, embedding_db)

        # Process them
        processed = process_queue(synced_app_db, embedding_db, batch_size=10)

        assert processed == 3  # 3 messages in fixture
        stats = embedding_db.get_stats()
        assert stats["pending"] == 0
        assert stats["completed"] == 3
        assert stats["total_embeddings"] == 3

    @pytest.mark.slow
    def test_queue_all_messages(self, synced_app_db: AppDb, embedding_db: EmbeddingDb):
        """queue_all_messages() queues all messages with text."""
        count = queue_all_messages(synced_app_db, embedding_db)

        assert count == 3
        stats = embedding_db.get_stats()
        assert stats["pending"] == 3
