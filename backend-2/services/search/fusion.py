"""Reciprocal Rank Fusion (RRF) for combining search results."""

from .models import SearchResult


def reciprocal_rank_fusion(
    fts_results: list[SearchResult],
    semantic_results: list[dict],
    k: int = 60,
) -> list[dict]:
    """Merge FTS and semantic results using RRF. Items in both lists get boosted."""
    scores: dict[int, dict] = {}

    for rank, r in enumerate(fts_results, start=1):
        scores[r.message_id] = {
            "score": 1.0 / (k + rank),
            "data": {
                "message_id": r.message_id,
                "chat_id": r.chat_id,
                "text": r.text,
                "timestamp": r.timestamp,
                "sender_name": r.sender_name,
                "chat_name": r.chat_name,
            },
        }

    for rank, r in enumerate(semantic_results, start=1):
        msg_id = r["message_id"]
        if msg_id in scores:
            scores[msg_id]["score"] += 1.0 / (k + rank)
        else:
            scores[msg_id] = {
                "score": 1.0 / (k + rank),
                "data": {
                    "message_id": msg_id,
                    "chat_id": r["chat_id"],
                    "text": "",
                    "timestamp": 0,
                    "sender_name": None,
                    "chat_name": None,
                },
                "needs_fetch": True,
            }

    return sorted(scores.values(), key=lambda x: x["score"], reverse=True)


def merge_results(
    fts_results: list[SearchResult],
    semantic_results: list[dict],
    get_message_text,
    limit: int = 50,
) -> list[SearchResult]:
    """Merge FTS and semantic results via RRF, fetching missing text."""
    if not fts_results and not semantic_results:
        return []

    merged = reciprocal_rank_fusion(fts_results, semantic_results)

    for item in merged:
        if item.get("needs_fetch"):
            item["data"]["text"] = get_message_text(item["data"]["message_id"]) or ""

    max_score = merged[0]["score"] if merged else 1
    for item in merged:
        item["data"]["rank"] = item["score"] / max_score

    return [SearchResult(**item["data"]) for item in merged[:limit]]
