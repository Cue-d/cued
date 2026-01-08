"""Chat priority calculation for LLM analysis queue.

Priority scoring for LLM analysis queue (0-100 scale, higher = processed sooner).
Uses a time-decay curve and contact importance signals.
"""


def _calculate_time_priority(hours_since: float) -> int:
    """
    Calculate priority based on time since last message using a curve.

    The "Goldilocks zone" is 2-72 hours:
    - 0-2 hours: Low priority (still in active conversation, don't interrupt)
    - 2-24 hours: Ramping up (conversation cooling, may need follow-up)
    - 24-72 hours: Peak priority (definitely needs attention)
    - 72-168 hours (3-7 days): Declining (getting stale)
    - 168+ hours: Low priority (probably too late to matter much)

    Returns: priority component (20-80)
    """
    if hours_since < 2:
        return 20  # Too fresh
    elif hours_since < 24:
        # Ramp from 40 to 70 over 22 hours
        return int(40 + (hours_since - 2) * (30 / 22))
    elif hours_since < 72:
        return 80  # Peak urgency zone
    elif hours_since < 168:  # 1 week
        # Decay from 80 to 40 over 96 hours
        return int(80 - (hours_since - 72) * (40 / 96))
    else:
        return 30  # Very old, low priority


def _calculate_contact_priority_boost(person: dict | None) -> int:
    """
    Calculate priority boost based on contact importance.

    Saved contacts with metadata are likely more important relationships.

    Args:
        person: Dict with is_contact, company, notes fields, or None

    Returns: priority boost (0-25)
    """
    if person is None:
        return 0

    boost = 0

    # Saved contacts are more important than unknown numbers
    if person.get("is_contact"):
        boost += 10

    # Company field suggests professional relationship
    if person.get("company"):
        boost += 10

    # Notes suggest you've documented this relationship
    if person.get("notes"):
        boost += 5

    return boost


def _calculate_group_penalty(is_group: bool) -> int:
    """
    Calculate priority penalty for group chats.

    Group chats are often less actionable - someone else may respond.

    Returns: penalty (negative value, -15 for groups)
    """
    return -15 if is_group else 0


def calculate_chat_priority(
    hours_since: float,
    person: dict | None = None,
    is_group: bool = False,
) -> int:
    """
    Calculate overall priority score for a chat's LLM analysis.

    Combines:
    - Time-decay curve (base priority)
    - Contact importance boost
    - Group chat penalty

    Args:
        hours_since: Hours since last message from them
        person: Dict with contact info (is_contact, company, notes) or None
        is_group: Whether this is a group chat

    Returns: priority score (10-100)
    """
    # Base priority from time curve (20-80)
    priority = _calculate_time_priority(hours_since)

    # Add contact importance boost (0-25)
    priority += _calculate_contact_priority_boost(person)

    # Apply group penalty (-15 or 0)
    priority += _calculate_group_penalty(is_group)

    # Clamp to valid range
    return max(10, min(100, priority))
