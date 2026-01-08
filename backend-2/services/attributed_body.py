"""Extract text from Apple's attributedBody blob format.

This is a Python port of the Rust implementation in core/src/utils.rs.
Used to extract message text when the `text` column is NULL in chat.db.
"""


def decode_length(data: bytes, offset: int = 0) -> tuple[int, int] | None:
    """Decode a variable-length integer used in Apple's typedstream format.

    Returns (bytes_consumed, length) or None if invalid.
    """
    if offset >= len(data):
        return None

    first = data[offset]

    if first < 0x80:
        return (1, first)
    elif first == 0x81:
        if offset + 2 >= len(data):
            return None
        b1 = data[offset + 1]
        b2 = data[offset + 2]
        return (3, b1 | (b2 << 8))
    elif first == 0x82:
        if offset + 3 >= len(data):
            return None
        b1 = data[offset + 1]
        b2 = data[offset + 2]
        b3 = data[offset + 3]
        return (4, b1 | (b2 << 8) | (b3 << 16))
    elif first == 0x83:
        if offset + 4 >= len(data):
            return None
        b1 = data[offset + 1]
        b2 = data[offset + 2]
        b3 = data[offset + 3]
        b4 = data[offset + 4]
        return (5, b1 | (b2 << 8) | (b3 << 16) | (b4 << 24))
    else:
        return None


def extract_text_from_attributed_body(blob: bytes) -> str | None:
    """Extract text from an attributedBody blob (Apple's typedstream format).

    This is used to extract message text when the `text` column is NULL.
    """
    if not blob:
        return None

    # Look for NSString marker
    ns_string = b"NSString"
    try:
        pos = blob.index(ns_string)
    except ValueError:
        return None

    search_start = pos + len(ns_string)
    after_marker = blob[search_start:]

    # Search for the text marker pattern
    for i in range(len(after_marker) - 6):
        first_byte = after_marker[i]
        if (first_byte == 0x94 or first_byte == 0x95) and len(after_marker) > i + 4:
            if (
                after_marker[i + 1] == 0x84
                and after_marker[i + 2] == 0x01
                and after_marker[i + 3] == 0x2B
            ):
                result = decode_length(after_marker, i + 4)
                if result is None:
                    continue

                len_bytes_consumed, text_len = result
                text_start = i + 4 + len_bytes_consumed

                if text_start + text_len <= len(after_marker):
                    text_bytes = after_marker[text_start : text_start + text_len]
                    try:
                        text = text_bytes.decode("utf-8")
                        trimmed = text.strip()

                        # Filter out internal Apple strings
                        if (
                            trimmed
                            and not trimmed.startswith("NS")
                            and not trimmed.startswith("_NS")
                            and "AttributeName" not in trimmed
                        ):
                            # Remove object replacement character (used for attachments)
                            filtered = trimmed.replace("\ufffc", "")
                            if filtered:
                                return filtered
                            else:
                                return "[attachment]"
                    except UnicodeDecodeError:
                        continue

    return None
