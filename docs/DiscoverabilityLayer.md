# PRM Discoverability Layer: Research & Implementation Design

## Executive Summary

This document outlines the research foundations and implementation strategies for building an intelligent discoverability layer for PRM. The goal is to surface the right conversations at the right time through semantic understanding, relationship intelligence, and light automation.

---

## 1. Semantic Search & Sort

### Research Foundation

**Embedding-Based Search**
- Modern semantic search embeds text into vector space where similar meanings cluster together ([SGPT Paper](https://arxiv.org/abs/2202.08904))
- [sqlite-vec](https://github.com/asg017/sqlite-vec) provides pure SQLite vector search—no external dependencies, runs everywhere
- [sqlite-lembed](https://alexgarcia.xyz/blog/2024/sqlite-lembed-init/index.html) generates embeddings locally using GGUF models
- Combined with [Anthropic's Contextual Retrieval](https://www.anthropic.com/news/contextual-retrieval), hybrid BM25 + embeddings reduces failed retrievals by 67%

**Key Insight**: For personal messaging, semantic sort isn't just "what is this about" but "who said what, when, in what emotional context."

### Implementation Strategy

```
┌─────────────────────────────────────────────────────────────────┐
│                    Embedding Pipeline                           │
├─────────────────────────────────────────────────────────────────┤
│  Message → Chunk (by conversation turn) → Embed → Store in DB   │
│                                                                 │
│  Model Options:                                                 │
│  - all-MiniLM-L6-v2 (22M params, fast, good quality)           │
│  - nomic-embed-text (137M, better quality, still fast)         │
│  - Use GGUF format via sqlite-lembed for on-device             │
└─────────────────────────────────────────────────────────────────┘
```

**Schema Extension** (`prm.db`):
```sql
-- Vector storage for semantic search
CREATE TABLE message_embeddings (
    message_id INTEGER PRIMARY KEY,
    conversation_id INTEGER,
    embedding BLOB,  -- float32 vector as blob
    chunk_text TEXT,
    created_at INTEGER,
    FOREIGN KEY (message_id) REFERENCES messages_cache(id)
);

-- Index for fast KNN queries (via sqlite-vec)
CREATE VIRTUAL TABLE vec_messages USING vec0(
    embedding float[384]  -- dimension depends on model
);
```

**Sort Modes**:
1. **Recency** (iMessage default): Most recent message timestamp
2. **Semantic Relevance**: Query embedding → KNN over conversation embeddings
3. **Engagement Score**: Combines recency + response rate + message length patterns
4. **Relationship Priority**: Weighted by contact importance score (see Section 3)

---

## 2. Missed Message Detection & Reminders

### Research Foundation

**The Problem**
- Users fear opening messages will mark them "read" and forgotten ([UX Research](https://medium.com/@thatameliawarren/the-fine-are-of-notifications-in-ux-19a41a0b0c15))
- Effective reminder systems reduce missed communications by 41% and improve response times by 64% ([MyShyft Research](https://www.myshyft.com/blog/unread-message-indicators/))

**Reply Reminder UX Patterns**
- Detect messages without reply after threshold (e.g., 15 minutes)
- Surface reminder after additional interval
- Key finding: Users couldn't find reminders in Settings; they looked in the message thread itself

### Implementation Strategy

**Detection Algorithm**:
```python
def detect_unanswered_messages(conversations, threshold_hours=24):
    """
    Find conversations where:
    1. Last message was from other party
    2. No reply sent within threshold
    3. Contact is not muted
    4. Message seems to expect a reply (not just "ok", "thanks", emoji)
    """
    unanswered = []
    for conv in conversations:
        last_msg = conv.last_message
        if (last_msg.is_from_me == False and
            last_msg.needs_reply_signal > 0.5 and
            hours_since(last_msg.timestamp) > threshold_hours and
            not conv.is_muted):
            unanswered.append(conv)
    return unanswered
```

**"Needs Reply" Signal**:
- Questions (ends with `?`)
- Direct address ("hey", "you there")
- Length > 50 chars (substantive message)
- Negative signals: single emoji, "ok", "thanks", "lol"

**UI Integration**:
- Surface in a "Waiting for Reply" filter/section
- Subtle indicator on conversation (not aggressive notification)
- User can dismiss or snooze
- Learn from user behavior: if they consistently ignore reminders for certain contacts, reduce frequency

**Reminder Cadence** (configurable):
```
Default:
- First reminder: 24 hours after received
- Second reminder: 3 days
- Final reminder: 7 days (then archive)

High-priority contacts:
- First reminder: 4 hours
- Escalate based on relationship score
```

---

## 3. Contact Importance Scoring

### Research Foundation

**Tie Strength Theory**
- Granovetter (1973): Tie strength = time + emotional intensity + intimacy + reciprocity
- Communication frequency alone is insufficient—temporal patterns matter ([EPJ Data Science](https://epjdatascience.springeropen.com/articles/10.1140/epjds/s13688-020-00256-5))
- If communication halts for >8x the previous frequency, the tie likely decays ([Temporal Patterns Research](https://epjdatascience.springeropen.com/articles/10.1140/epjds/s13688-017-0127-3))

**Centrality Measures** ([Cambridge Intelligence](https://cambridge-intelligence.com/keylines-faqs-social-network-analysis/)):
- **Degree centrality**: Raw connection count
- **Eigenvector centrality**: Connections weighted by connectedness of connections
- **Betweenness centrality**: How often this contact bridges between others

**Key Insight**: Combine behavioral signals (frequency, recency, response patterns) with explicit user signals (tags, pins, notes).

### Implementation Strategy

**Relationship Score Formula**:
```python
def calculate_relationship_score(contact, messages, user_signals):
    """
    Score from 0-100 representing relationship importance
    """
    # Behavioral signals (70% weight)
    behavioral = (
        frequency_score(messages) * 0.25 +      # How often you talk
        recency_score(messages) * 0.20 +        # When did you last talk
        reciprocity_score(messages) * 0.15 +    # Balance of sent/received
        response_time_score(messages) * 0.10    # How fast you reply
    )

    # User signals (30% weight)
    explicit = (
        (1 if contact.is_pinned else 0) * 0.10 +
        (1 if contact.has_notes else 0) * 0.05 +
        tag_importance(contact.tags) * 0.10 +
        manual_score(contact.manual_importance) * 0.05
    )

    return (behavioral + explicit) * 100
```

**Decay Function** (based on research that relationships decay without maintenance):
```python
def apply_decay(score, days_since_contact):
    """
    Exponential decay with half-life based on relationship tier

    Strong ties: half-life = 30 days
    Medium ties: half-life = 14 days
    Weak ties: half-life = 7 days
    """
    tier = get_tier(score)
    half_life = {
        'strong': 30,
        'medium': 14,
        'weak': 7
    }[tier]

    decay_factor = 0.5 ** (days_since_contact / half_life)
    return score * decay_factor
```

**Schema Extension**:
```sql
ALTER TABLE contacts ADD COLUMN relationship_score REAL DEFAULT 0;
ALTER TABLE contacts ADD COLUMN score_components JSON;  -- Store breakdown
ALTER TABLE contacts ADD COLUMN last_score_update INTEGER;

-- Track relationship trajectory
CREATE TABLE relationship_history (
    contact_id INTEGER,
    score REAL,
    recorded_at INTEGER,
    PRIMARY KEY (contact_id, recorded_at)
);
```

**Surfacing**:
- "Important" filter shows high-score contacts
- "Fading" filter shows contacts with rapidly decaying scores
- "Overdue" combines importance + time since contact

---

## 4. Auto Group Chat Suggestions

### Research Foundation

**Community Detection Algorithms** ([Nature Scientific Reports](https://www.nature.com/articles/srep30750)):
- **Louvain**: Fast, hierarchical, optimizes modularity—good for large networks
- **K-Clique**: Based on overlapping cliques—captures real-world community overlap
- **Label Propagation**: Simple, fast, but non-deterministic

**LINE Group Chat Research** ([IEEE](https://ieeexplore.ieee.org/document/10315557)):
- Messages classified as "conversation posts" vs "reaction posts"
- Graph constructed from content similarity and temporal proximity

**Key Insight**: For iMessage, groups should emerge from co-occurrence patterns (who do you message together?) and topic similarity (who do you discuss similar things with?).

### Implementation Strategy

**Signal Sources for Clustering**:
1. **Co-mention**: When you reference person A in conversation with person B
2. **Topic similarity**: Embedding similarity of conversations
3. **Temporal proximity**: People you message in the same time windows
4. **Explicit groups**: Existing group chats as ground truth

**Algorithm**:
```python
def suggest_groups(contacts, conversations):
    """
    Build contact graph, detect communities, suggest groups
    """
    # Build weighted adjacency matrix
    G = nx.Graph()
    for contact in contacts:
        G.add_node(contact.id)

    # Add edges based on co-occurrence signals
    for c1, c2 in combinations(contacts, 2):
        weight = (
            co_mention_score(c1, c2, conversations) * 0.4 +
            topic_similarity(c1, c2) * 0.3 +
            temporal_overlap(c1, c2) * 0.2 +
            shared_groups(c1, c2) * 0.1
        )
        if weight > 0.1:  # threshold
            G.add_edge(c1.id, c2.id, weight=weight)

    # Run Louvain community detection
    communities = nx.community.louvain_communities(G)

    # Filter to actionable suggestions
    suggestions = []
    for community in communities:
        if 3 <= len(community) <= 8:  # Sweet spot for group chats
            if not group_already_exists(community):
                suggestions.append({
                    'members': community,
                    'suggested_name': generate_name(community),
                    'rationale': explain_grouping(community)
                })

    return suggestions
```

**UI Presentation**:
- "Suggested Groups" section in contacts/search
- Show rationale: "You often message these people about hiking"
- One-click to create group
- Learn from dismissals: if user rejects a suggestion, reduce similar suggestions

---

## 5. The Unified Discoverability Layer

### Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                      DISCOVERABILITY ENGINE                      │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │  Embedding  │  │  Scoring    │  │  Detection  │              │
│  │  Service    │  │  Service    │  │  Service    │              │
│  └─────┬───────┘  └─────┬───────┘  └─────┬───────┘              │
│        │                │                │                       │
│        └────────────────┴────────────────┘                       │
│                         │                                        │
│                    ┌────▼────┐                                   │
│                    │  prm.db │                                   │
│                    │ + vec   │                                   │
│                    └────┬────┘                                   │
│                         │                                        │
│        ┌────────────────┼────────────────┐                       │
│        │                │                │                       │
│  ┌─────▼─────┐   ┌──────▼─────┐   ┌──────▼──────┐               │
│  │ Semantic  │   │  Smart     │   │  Group      │               │
│  │ Sort/     │   │  Reminders │   │  Suggestions│               │
│  │ Search    │   │            │   │             │               │
│  └───────────┘   └────────────┘   └─────────────┘               │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### API Design

```python
# backend/app/api/discoverability.py

@router.get("/conversations/smart-sort")
async def smart_sort_conversations(
    mode: SortMode = "engagement",  # recency | engagement | importance | semantic
    query: str = None,              # for semantic mode
    limit: int = 50
):
    """Return conversations sorted by specified intelligence mode"""

@router.get("/reminders/pending")
async def get_pending_reminders(
    priority: str = "all"  # all | high | medium | low
):
    """Return conversations awaiting reply, ranked by urgency"""

@router.get("/contacts/importance")
async def get_contacts_by_importance(
    filter: str = "all"  # all | fading | overdue | strong
):
    """Return contacts with relationship scores and trajectories"""

@router.get("/groups/suggestions")
async def get_group_suggestions(limit: int = 5):
    """Return suggested group chat configurations"""

@router.post("/contacts/{id}/score/manual")
async def update_manual_importance(id: int, importance: int):
    """Allow user to manually adjust importance (1-10)"""
```

---

## 6. Implementation Phases

### Phase 1: Foundation (Core Infrastructure)
- [ ] Add sqlite-vec extension to Rust core
- [ ] Create embedding pipeline for messages (batch + incremental)
- [ ] Extend prm.db schema with vector tables and score columns
- [ ] Implement basic relationship scoring (frequency + recency)

### Phase 2: Semantic Search
- [ ] Integrate embedding model (start with all-MiniLM-L6-v2)
- [ ] Implement semantic sort mode
- [ ] Add hybrid search (BM25 + embeddings)
- [ ] Build search UI with sort mode toggle

### Phase 3: Smart Reminders
- [ ] Implement missed message detection
- [ ] Build "needs reply" classifier
- [ ] Create reminder UI component
- [ ] Add user preference learning

### Phase 4: Relationship Intelligence
- [ ] Full relationship score implementation with decay
- [ ] Contact importance filters and views
- [ ] Relationship trajectory tracking
- [ ] "Fading relationships" surface

### Phase 5: Group Suggestions
- [ ] Build contact graph from message data
- [ ] Implement Louvain community detection
- [ ] Create suggestion UI with rationale
- [ ] Add feedback loop for learning

---

## 7. Technical Considerations

### Performance
- Embedding generation is CPU-intensive; batch during idle time or on first sync
- sqlite-vec uses SIMD acceleration for fast KNN
- Relationship scores should be computed incrementally on new messages
- Consider worker thread/process for background ML tasks

### Privacy
- All ML runs on-device—no data leaves the machine
- Embeddings are stored locally in prm.db
- No cloud dependencies for core functionality

### Model Updates
- Use GGUF format for easy model swapping
- Consider periodic re-embedding if user upgrades model
- Store model version with embeddings for compatibility

### Rust/Python Split
Given your architecture:
- **Rust** (`core/`): sqlite-vec integration, embedding storage, KNN queries
- **Python** (`backend/`): ML model inference (via sentence-transformers or local GGUF), scoring algorithms, API endpoints
- **Frontend**: UI for sort modes, reminders, suggestions

---

## 8. Research Sources

### Semantic Search & Embeddings
- [SGPT Paper](https://arxiv.org/abs/2202.08904)
- [sqlite-vec](https://github.com/asg017/sqlite-vec)
- [sqlite-lembed](https://alexgarcia.xyz/blog/2024/sqlite-lembed-init/index.html)
- [Anthropic Contextual Retrieval](https://www.anthropic.com/news/contextual-retrieval)
- [Sentence Transformers](https://sbert.net/examples/sentence_transformer/applications/semantic-search/README.html)

### Tie Strength & Relationships
- [Estimating Tie Strength](https://epjdatascience.springeropen.com/articles/10.1140/epjds/s13688-020-00256-5)
- [Temporal Patterns in Persistent Ties](https://epjdatascience.springeropen.com/articles/10.1140/epjds/s13688-017-0127-3)
- [Managing Relationship Decay](https://pmc.ncbi.nlm.nih.gov/articles/PMC4626528/)
- [Centrality Measures Explained](https://cambridge-intelligence.com/keylines-faqs-social-network-analysis/)

### Reminder Systems & UX
- [Notification UX Study](https://medium.com/@thatameliawarren/the-fine-are-of-notifications-in-ux-19a41a0b0c15)
- [Unread Message Indicators](https://www.myshyft.com/blog/unread-message-indicators/)
- [Notification Design Guide](https://www.toptal.com/designers/ux/notification-design)

### Community Detection
- [Comparative Analysis of Community Detection](https://www.nature.com/articles/srep30750)
- [Community Detection Overview](https://towardsdatascience.com/community-detection-algorithms-9bd8951e7dae)
- [LINE Group Chat Communication Structures](https://ieeexplore.ieee.org/document/10315557)

### Personal CRM Landscape
- [Personal CRM Comparison 2025](https://crm.org/crmland/personal-crm)
- [Clay](https://clay.earth), [Dex](https://getdex.com), [Monica](https://www.monicahq.com)

---

## 9. Guiding Principles

1. **Light automation, not intrusion**: Surface insights, don't force actions
2. **Local-first, always**: All ML on-device, no cloud dependencies
3. **Explainable**: Show users *why* something is suggested
4. **Learnable**: Adapt to user behavior over time
5. **Graceful degradation**: Works without ML, better with it
