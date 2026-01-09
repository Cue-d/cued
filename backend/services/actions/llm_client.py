"""
LLM Client - Wrapper for the prm-llm Swift CLI.

Uses Apple Intelligence (Foundation Models) via AnyLanguageModel to generate
intelligent action suggestions based on conversation context.

Each conversation is analyzed independently with one LLM call per conversation.
Multiple conversations are analyzed in parallel using a thread pool for better performance.
"""

import json
import logging
import os
import subprocess
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from pydantic import BaseModel

logger = logging.getLogger(__name__)

# Default path to the prm-llm binary (relative to project root, for development)
DEFAULT_LLM_BINARY_PATH = (
    Path(__file__).parent.parent.parent.parent / "llm" / ".build" / "release" / "prm-llm"
)

# Environment variable to override the binary path
LLM_BINARY_ENV_VAR = "PRM_LLM_BINARY"

# Timeout for LLM calls (seconds)
LLM_TIMEOUT = 30

# Maximum number of parallel LLM calls
MAX_PARALLEL_LLM_CALLS = 5


class LLMError(Exception):
    """Error from the LLM client."""


class ContentSafetyError(LLMError):
    """Content was flagged as potentially unsafe by the LLM."""

    pass


class ConversationContext(BaseModel):
    """Context for a single conversation to analyze."""

    chat_id: int
    person_id: int | None
    person_name: str | None
    person_company: str | None
    person_notes: str | None
    messages: list[dict]  # [{"text": str, "is_from_me": bool, "timestamp": int}]
    hours_since_last: float


class ActionSuggestion(BaseModel):
    """An action suggested by the LLM."""

    chat_id: int
    action_type: str  # "respond_to_message", "follow_up", "eod_contact"
    priority: int  # 0-100
    reason: str
    remind_at: int | None = None


def _get_packaged_llm_path() -> Path | None:
    """Get the LLM binary path when running as a packaged PyInstaller executable.

    When packaged with Electron, the layout is:
        resources/
            backend/prm-backend  (PyInstaller executable)
            llm/prm-llm          (Swift binary)

    We use sys.executable to find the backend location, then navigate to llm/.
    """
    import sys

    # Check if running as PyInstaller bundle
    if not getattr(sys, "frozen", False):
        return None

    # sys.executable points to resources/backend/prm-backend
    # We want resources/llm/prm-llm
    executable_path = Path(sys.executable)
    llm_path = executable_path.parent.parent / "llm" / "prm-llm"
    return llm_path


def get_llm_binary_path() -> Path:
    """Get the path to the prm-llm binary.

    Checks in order:
    1. Environment variable PRM_LLM_BINARY
    2. Packaged app location (resources/llm/prm-llm) - when running as PyInstaller bundle
    3. Development location (llm/.build/release/prm-llm)
    """
    env_path = os.environ.get(LLM_BINARY_ENV_VAR)
    if env_path:
        return Path(env_path)

    # Check packaged app location first (for production builds)
    packaged_path = _get_packaged_llm_path()
    if packaged_path and packaged_path.exists():
        return packaged_path

    return DEFAULT_LLM_BINARY_PATH


def is_llm_available() -> bool:
    """Check if the LLM binary is available."""
    binary_path = get_llm_binary_path()
    return binary_path.exists() and os.access(binary_path, os.X_OK)


def sanitize_text(text: str | None) -> str:
    """Sanitize text by removing problematic characters."""
    if not text:
        return ""

    # Remove null bytes and other control characters (keep newlines, tabs)
    result = "".join(
        char for char in text if char in "\n\r\t" or (ord(char) >= 0x20 and ord(char) != 0x7F)
    )

    # Limit length to avoid overwhelming the model
    if len(result) > 1000:
        result = result[:1000] + "..."

    return result


def format_conversation_as_text(ctx: ConversationContext) -> str:
    """Format a conversation context as plain text for the LLM."""
    lines = []

    # Contact info
    if ctx.person_name:
        name = sanitize_text(ctx.person_name)
        contact_line = f"Contact: {name}"
        if ctx.person_company:
            contact_line += f" ({sanitize_text(ctx.person_company)})"
        lines.append(contact_line)
        if ctx.person_notes:
            lines.append(f"Notes: {sanitize_text(ctx.person_notes)}")

    # Time context
    lines.append(f"Hours since last message: {int(ctx.hours_since_last)}")
    lines.append("")
    lines.append("Messages:")

    # Sort messages by timestamp (oldest first) and take last 10
    sorted_messages = sorted(ctx.messages, key=lambda m: m.get("timestamp", 0))[-10:]

    for msg in sorted_messages:
        if msg.get("is_from_me"):
            sender = "Me"
        else:
            # Use sender_name if available (for group chats), otherwise "Them"
            sender_name = msg.get("sender_name")
            sender = sanitize_text(sender_name) if sender_name else "Them"
        text = sanitize_text(msg.get("text")) or "[attachment]"
        lines.append(f"  {sender}: {text}")

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

    logger.debug(f"Analyzing conversation for chat_id={ctx.chat_id}")

    if not is_llm_available():
        raise LLMError(f"LLM binary not found at {binary_path}")

    # Format conversation as plain text
    conversation_text = format_conversation_as_text(ctx)

    try:
        result = subprocess.run(
            [str(binary_path)],
            input=conversation_text,
            capture_output=True,
            text=True,
            timeout=LLM_TIMEOUT,
        )

        if result.returncode != 0:
            error_msg = result.stderr.strip() if result.stderr else "Unknown error"
            # Check for content safety errors (from Apple's MLX LLM)
            if "unsafe" in error_msg.lower():
                logger.debug(f"Content flagged as unsafe for chat_id={ctx.chat_id}")
                raise ContentSafetyError("Content flagged as unsafe")
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


def generate_actions(
    contexts: list[ConversationContext], max_workers: int | None = None
) -> list[ActionSuggestion]:
    """
    Generate action suggestions for multiple conversations in parallel.

    Each conversation is analyzed independently with one LLM call per conversation.
    Multiple conversations are processed concurrently using a thread pool.

    Args:
        contexts: List of conversation contexts to analyze
        max_workers: Maximum parallel LLM calls (default: MAX_PARALLEL_LLM_CALLS)

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

    workers = max_workers or MAX_PARALLEL_LLM_CALLS
    suggestions = []

    with ThreadPoolExecutor(max_workers=workers) as executor:
        # Submit all conversations for parallel processing
        future_to_ctx = {executor.submit(analyze_conversation, ctx): ctx for ctx in contexts}

        for future in as_completed(future_to_ctx):
            ctx = future_to_ctx[future]
            try:
                suggestion = future.result()
                if suggestion:
                    suggestions.append(suggestion)
            except LLMError as e:
                # Log and continue with other conversations
                logger.warning(f"Failed to analyze chat_id={ctx.chat_id}: {e}")
                continue

    logger.info(
        f"LLM analyzed {len(contexts)} conversations in parallel (workers={workers}), "
        f"generated {len(suggestions)} action suggestions"
    )
    return suggestions
