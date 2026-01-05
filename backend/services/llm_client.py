"""
LLM Client - Wrapper for the prm-llm Swift CLI.

Uses Apple Intelligence (Foundation Models) via AnyLanguageModel to generate
intelligent action suggestions based on conversation context.

Each conversation is analyzed independently with one LLM call per conversation
to avoid context degradation.
"""

import json
import logging
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)

# Default path to the prm-llm binary (relative to project root)
DEFAULT_LLM_BINARY_PATH = (
    Path(__file__).parent.parent.parent / "llm" / ".build" / "release" / "prm-llm"
)

# Environment variable to override the binary path
LLM_BINARY_ENV_VAR = "PRM_LLM_BINARY"

# Timeout for LLM calls (seconds)
LLM_TIMEOUT = 30


@dataclass
class ConversationContext:
    """Context for a single conversation to analyze."""

    chat_id: int
    person_id: int | None
    person_name: str | None
    person_company: str | None
    person_notes: str | None
    messages: list[dict]  # [{"text": str, "is_from_me": bool, "timestamp": int}]
    hours_since_last: float


@dataclass
class ActionSuggestion:
    """An action suggested by the LLM."""

    chat_id: int
    action_type: str  # "respond_to_message", "follow_up", "eod_contact"
    priority: int  # 0-100
    reason: str
    remind_at: int | None = None


def get_llm_binary_path() -> Path:
    """Get the path to the prm-llm binary."""
    env_path = os.environ.get(LLM_BINARY_ENV_VAR)
    if env_path:
        return Path(env_path)
    return DEFAULT_LLM_BINARY_PATH


def is_llm_available() -> bool:
    """Check if the LLM binary is available."""
    binary_path = get_llm_binary_path()
    return binary_path.exists() and os.access(binary_path, os.X_OK)


def format_conversation_as_text(ctx: ConversationContext) -> str:
    """Format a conversation context as plain text for the LLM."""
    lines = []

    # Contact info
    if ctx.person_name:
        contact_line = f"Contact: {ctx.person_name}"
        if ctx.person_company:
            contact_line += f" ({ctx.person_company})"
        lines.append(contact_line)
        if ctx.person_notes:
            lines.append(f"Notes: {ctx.person_notes}")

    # Time context
    lines.append(f"Hours since last message: {int(ctx.hours_since_last)}")
    lines.append("")
    lines.append("Messages:")

    # Messages (last 10 for context)
    for msg in ctx.messages[-10:]:
        sender = "Me" if msg.get("is_from_me") else "Them"
        text = msg.get("text") or "[attachment]"
        lines.append(f"  [{sender}]: {text}")

    return "\n".join(lines)


def analyze_conversation(ctx: ConversationContext) -> ActionSuggestion | None:
    """
    Analyze a single conversation using the LLM.

    Args:
        ctx: Conversation context to analyze

    Returns:
        ActionSuggestion if the LLM suggests an action, None otherwise

    Raises:
        LLMError: If the LLM call fails
    """
    binary_path = get_llm_binary_path()

    if not is_llm_available():
        raise LLMError(f"LLM binary not found at {binary_path}")

    # Format conversation as plain text
    conversation_text = format_conversation_as_text(ctx)

    try:
        logger.debug(f"Analyzing conversation for chat_id={ctx.chat_id}")

        result = subprocess.run(
            [str(binary_path)],
            input=conversation_text,
            capture_output=True,
            text=True,
            timeout=LLM_TIMEOUT,
        )

        if result.returncode != 0:
            error_msg = result.stderr.strip() if result.stderr else "Unknown error"
            logger.error(f"LLM call failed for chat_id={ctx.chat_id}: {error_msg}")
            raise LLMError(f"LLM call failed: {error_msg}")

        # Parse JSON output
        try:
            output = json.loads(result.stdout)
        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse LLM output: {e}")
            raise LLMError(f"Invalid LLM output: {e}") from e

        # Check if action is suggested
        action = output.get("action")
        if not action:
            logger.debug(f"No action needed for chat_id={ctx.chat_id}")
            return None

        suggestion = ActionSuggestion(
            chat_id=ctx.chat_id,
            action_type=action["type"],
            priority=action["priority"],
            reason=action.get("payload", {}).get("reason", ""),
            remind_at=action.get("remind_at"),
        )

        logger.debug(
            f"LLM suggested {suggestion.action_type} "
            f"(priority={suggestion.priority}) for chat_id={ctx.chat_id}"
        )
        return suggestion

    except subprocess.TimeoutExpired:
        logger.error(f"LLM call timed out after {LLM_TIMEOUT}s for chat_id={ctx.chat_id}")
        raise LLMError(f"LLM call timed out after {LLM_TIMEOUT}s") from None

    except FileNotFoundError:
        logger.error(f"LLM binary not found: {binary_path}")
        raise LLMError(f"LLM binary not found: {binary_path}") from None


def generate_actions(contexts: list[ConversationContext]) -> list[ActionSuggestion]:
    """
    Generate action suggestions for multiple conversations.

    Each conversation is analyzed independently with one LLM call per conversation.

    Args:
        contexts: List of conversation contexts to analyze

    Returns:
        List of suggested actions (only for conversations that need action)

    Raises:
        LLMError: If the LLM binary is not available
    """
    if not contexts:
        return []

    if not is_llm_available():
        binary_path = get_llm_binary_path()
        logger.warning(f"LLM binary not found at {binary_path}")
        raise LLMError(f"LLM binary not found at {binary_path}")

    suggestions = []
    for ctx in contexts:
        try:
            suggestion = analyze_conversation(ctx)
            if suggestion:
                suggestions.append(suggestion)
        except LLMError as e:
            # Log and continue with other conversations
            logger.warning(f"Failed to analyze chat_id={ctx.chat_id}: {e}")
            continue

    logger.info(
        f"LLM analyzed {len(contexts)} conversations, "
        f"generated {len(suggestions)} action suggestions"
    )
    return suggestions


class LLMError(Exception):
    """Error from the LLM client."""

    pass
