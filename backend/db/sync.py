"""Sync text cache from chat.db for FTS5 and embeddings.

This module handles:
1. Extracting message text from chat.db (including attributedBody)
2. Caching extracted text in prm.db for FTS5/embeddings
3. Detecting deleted messages and cleaning up orphaned entries
"""

import time

from services.attributed_body import extract_text_from_attributed_body

from .chat_db import ChatDb
from .prm_db import AppDb


def get_message_text(text_col: str | None, attributed_body: bytes | None) -> str | None:
    """Get message text, falling back to attributedBody extraction if text is null."""
    if text_col:
        return text_col
    if attributed_body:
        return extract_text_from_attributed_body(attributed_body)
    return None


def sync_text_cache(chat_db: ChatDb, app_db: AppDb, verbose: bool = False) -> dict:
    """
    Incremental sync: extract text from new messages, update cache.

    This is the main sync function that runs every 30 seconds.
    It only processes messages newer than the last synced ROWID.

    Returns:
        dict with keys: new_messages, elapsed
    """
    start = time.time()
    now = int(time.time())

    # Get last synced message ROWID
    last_rowid = app_db.get_last_synced_rowid()

    if verbose:
        print(f"Syncing text cache from ROWID {last_rowid}...")

    # Fetch new messages from chat.db
    new_messages = chat_db.get_new_messages_since(last_rowid)

    if not new_messages:
        return {"new_messages": 0, "elapsed": time.time() - start}

    # Extract text and batch insert
    texts_to_cache = []
    max_rowid = last_rowid

    for msg in new_messages:
        text = get_message_text(msg["text"], msg["attributedBody"])
        if text and text.strip():
            texts_to_cache.append((msg["rowid"], msg["chat_id"], text))
        max_rowid = max(max_rowid, msg["rowid"])

    # Batch insert into cache
    if texts_to_cache:
        app_db.cache_message_texts_batch(texts_to_cache, synced_at=now)

    # Update sync state
    app_db.set_last_synced_rowid(max_rowid)

    elapsed = time.time() - start
    if verbose:
        print(f"Cached {len(texts_to_cache)} messages in {elapsed:.2f}s")

    return {"new_messages": len(texts_to_cache), "elapsed": elapsed}


def sync_text_cache_full(chat_db: ChatDb, app_db: AppDb, verbose: bool = True) -> dict:
    """
    Full sync: rebuild entire text cache from chat.db.

    Used on first startup or for recovery. More expensive than incremental sync.
    Also rebuilds FTS5 index after populating the text cache.

    Returns:
        dict with keys: total_messages, cached_messages, elapsed
    """
    from services.search.fts import FtsIndex

    start = time.time()
    now = int(time.time())

    if verbose:
        print("=" * 60)
        print("Full text cache sync from chat.db")
        print("=" * 60)

    # Get all messages from chat.db (starting from ROWID 0)
    all_messages = chat_db.get_new_messages_since(0)

    if verbose:
        print(f"Found {len(all_messages)} messages in chat.db")

    # Extract text and batch insert
    texts_to_cache = []
    max_rowid = 0

    for msg in all_messages:
        text = get_message_text(msg["text"], msg["attributedBody"])
        if text and text.strip():
            texts_to_cache.append((msg["rowid"], msg["chat_id"], text))
        max_rowid = max(max_rowid, msg["rowid"])

        if verbose and len(texts_to_cache) % 10000 == 0 and len(texts_to_cache) > 0:
            print(f"   ... processed {len(texts_to_cache)} messages")

    # Batch insert into cache
    if texts_to_cache:
        app_db.cache_message_texts_batch(texts_to_cache, synced_at=now)

    # Rebuild FTS5 index
    if verbose:
        print("Rebuilding FTS5 index...")
    fts = FtsIndex(app_db.engine)
    fts_count = fts.rebuild()
    if verbose:
        print(f"FTS5 index rebuilt with {fts_count} messages")

    # Update sync state
    app_db.set_last_synced_rowid(max_rowid)

    elapsed = time.time() - start
    if verbose:
        print(f"\nCached {len(texts_to_cache)} messages in {elapsed:.2f}s")
        print("=" * 60)

    return {
        "total_messages": len(all_messages),
        "cached_messages": len(texts_to_cache),
        "elapsed": elapsed,
    }


def detect_deletions(
    chat_db: ChatDb, app_db: AppDb, embedding_db=None, verbose: bool = False
) -> int:
    """
    Detect deleted messages and clean up orphaned entries.

    Compares cached message IDs with current chat.db message IDs.
    Removes orphaned entries from:
    - message_text_cache (prm.db)
    - message_embeddings (embeddings.db) if provided

    Returns:
        Count of deleted messages cleaned up
    """
    start = time.time()

    # Get all cached message IDs
    cached_ids = app_db.get_all_cached_message_ids()

    if not cached_ids:
        return 0

    # Get all current message IDs from chat.db
    current_ids = chat_db.get_all_message_rowids()

    # Find orphaned entries (in cache but not in chat.db)
    deleted_ids = cached_ids - current_ids

    if not deleted_ids:
        return 0

    if verbose:
        print(f"Detected {len(deleted_ids)} deleted messages")

    # Remove from text cache
    app_db.delete_cached_messages(list(deleted_ids))

    # Remove from embeddings if provided
    if embedding_db is not None:
        try:
            embedding_db.delete_embeddings(list(deleted_ids))
        except Exception as e:
            if verbose:
                print(f"Warning: Failed to delete embeddings: {e}")

    elapsed = time.time() - start
    if verbose:
        print(f"Cleaned up {len(deleted_ids)} deleted messages in {elapsed:.2f}s")

    return len(deleted_ids)
