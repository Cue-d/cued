#!/usr/bin/env python3
"""Qualitative test for search: FTS5, semantic, and unified RRF."""

import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from db.prm_db import AppDb
from search import EmbeddingDb, FtsIndex, merge_results, process_queue, queue_all_messages, semantic_search
from search.semantic import get_model

PRM_DB = os.path.expanduser("~/.prm/prm.db")
EMBED_DB = os.path.expanduser("~/.prm/embeddings.db")


def header(title: str):
    print(f"\n{'=' * 60}\n  {title}\n{'=' * 60}\n")


def main():
    header("Search Qualitative Test")

    if not os.path.exists(PRM_DB):
        print(f"ERROR: {PRM_DB} not found. Run sync first.")
        sys.exit(1)

    app_db = AppDb(PRM_DB)
    embed_db = EmbeddingDb(EMBED_DB)
    embed_db.init_schema()
    fts = FtsIndex(app_db.engine)
    fts.init()

    # Rebuild FTS if empty
    try:
        if not fts.search("test", 1):
            print("FTS empty, rebuilding...")
            print(f"Indexed {fts.rebuild()} messages")
    except Exception:
        print(f"Indexed {fts.rebuild()} messages")

    header("Embedding Status")
    stats = embed_db.get_stats()
    print(f"Pending: {stats['pending']}, Completed: {stats['completed']}, Total: {stats['total_embeddings']}")

    if stats["total_embeddings"] == 0:
        print("\nNo embeddings. Queueing...")
        print(f"Queued {queue_all_messages(app_db, embed_db)} messages")
        print("Processing first batch...")
        get_model()
        print(f"Processed {process_queue(app_db, embed_db, 100)} embeddings")
        stats = embed_db.get_stats()

    queries = ["hello", "meeting tomorrow", "thanks", "coffee"]

    header("FTS5 Search")
    for q in queries:
        start = time.time()
        results = fts.search(q, 5)
        print(f"\n'{q}' ({len(results)} results, {time.time()-start:.3f}s)")
        for i, r in enumerate(results[:3], 1):
            print(f"  {i}. [{r.message_id}] {r.text[:50]}...")

    if stats["total_embeddings"] > 0:
        header("Semantic Search")
        for q in queries:
            start = time.time()
            results = semantic_search(embed_db, q, 5)
            print(f"\n'{q}' ({len(results)} results, {time.time()-start:.3f}s)")
            for i, r in enumerate(results[:3], 1):
                txt = app_db.get_message_text(r["message_id"]) or ""
                print(f"  {i}. [{r['message_id']}] {txt[:50]}... (sim={r['similarity']:.3f})")

        header("Unified RRF Search")
        for q in queries:
            start = time.time()
            fts_r = fts.search(q, 50)
            sem_r = semantic_search(embed_db, q, 50)
            merged = merge_results(fts_r, sem_r, app_db.get_message_text, 5)
            print(f"\n'{q}' ({len(merged)} results, {time.time()-start:.3f}s)")
            for i, r in enumerate(merged[:3], 1):
                print(f"  {i}. [{r.message_id}] {r.text[:50]}... (rank={r.rank:.3f})")

    header("Done!")


if __name__ == "__main__":
    main()
