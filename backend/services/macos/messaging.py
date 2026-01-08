"""iMessage sending via AppleScript."""

import subprocess

from pydantic import BaseModel


class SendResult(BaseModel):
    """Result of a send attempt."""

    success: bool
    error: str | None = None
    recipient: str


def _escape_applescript_string(s: str) -> str:
    """Escape a string for use in AppleScript."""
    return s.replace("\\", "\\\\").replace('"', '\\"')


def _execute_applescript(script: str, recipient: str) -> SendResult:
    """Execute an AppleScript and return a SendResult."""
    result = subprocess.run(
        ["osascript", "-e", script],
        capture_output=True,
        text=True,
    )

    if result.returncode == 0:
        return SendResult(success=True, recipient=recipient)
    else:
        return SendResult(
            success=False,
            error=result.stderr.strip() or "Unknown error",
            recipient=recipient,
        )


def send_message(recipient: str, message: str) -> SendResult:
    """Send a text message via iMessage to a phone number or email."""
    escaped_message = _escape_applescript_string(message)
    escaped_recipient = _escape_applescript_string(recipient)

    script = f'''
        tell application "Messages"
            set targetService to 1st account whose service type = iMessage
            set targetBuddy to participant "{escaped_recipient}" of targetService
            send "{escaped_message}" to targetBuddy
        end tell
    '''

    return _execute_applescript(script, recipient)


def send_to_group(chat_identifier: str, message: str) -> SendResult:
    """Send a message to a group chat by chat identifier."""
    escaped_message = _escape_applescript_string(message)

    # Format the chat ID for Messages.app: "iMessage;+;chat..."
    if chat_identifier.startswith("chat"):
        full_chat_id = f"iMessage;+;{chat_identifier}"
    else:
        full_chat_id = chat_identifier

    escaped_chat = _escape_applescript_string(full_chat_id)

    script = f'''
        tell application "Messages"
            set targetChat to chat id "{escaped_chat}"
            send "{escaped_message}" to targetChat
        end tell
    '''

    return _execute_applescript(script, chat_identifier)
