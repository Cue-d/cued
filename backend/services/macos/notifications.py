"""Desktop notifications via macOS Notification Center.

Uses osascript to display native macOS notifications.
Supports scheduled notifications that can be cancelled or rescheduled.
"""

import logging
import subprocess
import threading
import time

logger = logging.getLogger(__name__)

# Store scheduled notification timers by action_id for cancellation
_scheduled_notifications: dict[int, threading.Timer] = {}
_lock = threading.Lock()


def _escape_applescript_string(s: str) -> str:
    """Escape a string for use in AppleScript."""
    return s.replace("\\", "\\\\").replace('"', '\\"')


def send_notification(
    title: str,
    message: str,
    subtitle: str | None = None,
    sound: str | None = "default",
) -> bool:
    """Send a macOS desktop notification immediately.

    Args:
        title: The notification title (bold text)
        message: The notification body text
        subtitle: Optional subtitle (shown below title)
        sound: Sound name ("default", "Basso", "Blow", etc.) or None for silent

    Returns:
        True if notification was sent successfully, False otherwise
    """
    escaped_title = _escape_applescript_string(title)
    escaped_message = _escape_applescript_string(message)

    # Build the display notification command
    parts = [f'display notification "{escaped_message}"']
    parts.append(f'with title "{escaped_title}"')

    if subtitle:
        escaped_subtitle = _escape_applescript_string(subtitle)
        parts.append(f'subtitle "{escaped_subtitle}"')

    if sound:
        parts.append(f'sound name "{sound}"')

    script = " ".join(parts)

    try:
        result = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True,
            text=True,
            timeout=5,
        )

        if result.returncode != 0:
            logger.warning(f"Notification failed: {result.stderr.strip()}")
            return False

        return True

    except subprocess.TimeoutExpired:
        logger.warning("Notification timed out")
        return False
    except Exception as e:
        logger.warning(f"Notification error: {e}")
        return False


def _build_action_notification_content(
    action_type: str,
    person_name: str | None = None,
    message_preview: str | None = None,
) -> tuple[str, str, str | None]:
    """Build notification content for an action.

    Returns:
        Tuple of (title, message, subtitle)
    """
    # Build title based on action type
    type_labels = {
        "respond_to_message": "Reminder: Message needs response",
        "eod_contact": "Reminder: New contact to review",
        "follow_up": "Reminder: Follow-up needed",
    }
    title = type_labels.get(action_type, "Action reminder")

    # Build subtitle (person name)
    subtitle = person_name if person_name else None

    # Build message body
    if message_preview:
        # Truncate long messages
        if len(message_preview) > 100:
            message = message_preview[:97] + "..."
        else:
            message = message_preview
    else:
        message = "Open PRM to view details"

    return title, message, subtitle


def schedule_action_notification(
    action_id: int,
    remind_at: int,
    action_type: str,
    person_name: str | None = None,
    message_preview: str | None = None,
) -> bool:
    """Schedule a notification for a future time.

    Args:
        action_id: The action ID (used to cancel/reschedule)
        remind_at: Unix timestamp for when to show notification
        action_type: Type of action (respond_to_message, eod_contact, follow_up)
        person_name: Name of the person
        message_preview: Optional preview of the message text

    Returns:
        True if notification was scheduled successfully
    """
    # Cancel any existing notification for this action
    cancel_scheduled_notification(action_id)

    # Calculate delay
    delay = remind_at - time.time()
    if delay <= 0:
        # Already past, send immediately
        title, message, subtitle = _build_action_notification_content(
            action_type, person_name, message_preview
        )
        return send_notification(title=title, message=message, subtitle=subtitle)

    # Build notification content
    title, message, subtitle = _build_action_notification_content(
        action_type, person_name, message_preview
    )

    def send_scheduled():
        """Callback to send the notification."""
        with _lock:
            # Remove from scheduled dict
            _scheduled_notifications.pop(action_id, None)

        logger.info(f"Sending scheduled notification for action_id={action_id}")
        send_notification(title=title, message=message, subtitle=subtitle)

    # Create and store the timer
    timer = threading.Timer(delay, send_scheduled)
    timer.daemon = True  # Don't block app shutdown

    with _lock:
        _scheduled_notifications[action_id] = timer

    timer.start()
    logger.info(
        f"Scheduled notification for action_id={action_id} in {delay:.0f} seconds (at {remind_at})"
    )
    return True


def cancel_scheduled_notification(action_id: int) -> bool:
    """Cancel a scheduled notification for an action.

    Args:
        action_id: The action ID to cancel notification for

    Returns:
        True if a notification was cancelled, False if none existed
    """
    with _lock:
        timer = _scheduled_notifications.pop(action_id, None)

    if timer:
        timer.cancel()
        logger.info(f"Cancelled scheduled notification for action_id={action_id}")
        return True

    return False


def get_scheduled_notification_count() -> int:
    """Get the number of currently scheduled notifications.

    Returns:
        Number of pending scheduled notifications
    """
    with _lock:
        return len(_scheduled_notifications)


def notify_new_action(
    action_type: str,
    person_name: str | None = None,
    message_preview: str | None = None,
) -> bool:
    """Send notification for a newly created action (DEPRECATED - use schedule_action_notification).

    This sends an immediate notification. For scheduled reminders, use
    schedule_action_notification instead.

    Args:
        action_type: Type of action (respond_to_message, eod_contact, follow_up)
        person_name: Name of the person (or phone/email if unknown)
        message_preview: Optional preview of the message text

    Returns:
        True if notification was sent successfully
    """
    title, message, subtitle = _build_action_notification_content(
        action_type, person_name, message_preview
    )

    # Adjust title for immediate notification (remove "Reminder:" prefix)
    type_labels = {
        "respond_to_message": "Message needs response",
        "eod_contact": "New contact to review",
        "follow_up": "Follow-up reminder",
    }
    title = type_labels.get(action_type, "New action")

    return send_notification(
        title=title,
        message=message,
        subtitle=subtitle,
        sound="default",
    )
