"""Embedding batch processor job.

Processes messages in batches to generate embeddings for semantic search.

Schedule: Every 5 minutes
"""

import logging

from services.search.semantic import process_queue

logger = logging.getLogger(__name__)

# Number of messages to process per batch
BATCH_SIZE = 50


def run_embedding_batch(app_db, embedding_db, batch_size: int = BATCH_SIZE) -> None:
    """Process a batch of messages for embedding generation.

    Args:
        app_db: AppDb instance for getting message text
        embedding_db: EmbeddingDb instance for storing embeddings
        batch_size: Number of messages to process per batch
    """
    processed = process_queue(app_db, embedding_db, batch_size)

    if processed > 0:
        logger.info(f"[embedding_batch] Processed {processed} embeddings")
    else:
        logger.debug("[embedding_batch] No pending embeddings to process")
