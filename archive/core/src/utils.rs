//! Utility functions - some exposed to Python.

use pyo3::prelude::*;
use std::time::{SystemTime, UNIX_EPOCH};

// ============================================
// ATTRIBUTED BODY PARSING
// ============================================

/// Extract text from an attributedBody blob (Apple's typedstream format).
/// This is used to extract message text when the `text` column is NULL.
pub fn extract_text_from_attributed_body(blob: &[u8]) -> Option<String> {
    let ns_string = b"NSString";
    let pos = blob.windows(ns_string.len()).position(|w| w == ns_string)?;

    let search_start = pos + ns_string.len();
    let after_marker = &blob[search_start..];

    for i in 0..after_marker.len().saturating_sub(6) {
        let first_byte = after_marker.get(i);
        if (first_byte == Some(&0x94) || first_byte == Some(&0x95))
            && after_marker.get(i + 1) == Some(&0x84)
            && after_marker.get(i + 2) == Some(&0x01)
            && after_marker.get(i + 3) == Some(&0x2B)
        {
            let (len_bytes_consumed, text_len) = decode_length(&after_marker[i + 4..])?;
            let text_start = i + 4 + len_bytes_consumed;

            if text_start + text_len <= after_marker.len() {
                let text_bytes = &after_marker[text_start..text_start + text_len];
                if let Ok(text) = std::str::from_utf8(text_bytes) {
                    let trimmed = text.trim();
                    if !trimmed.is_empty()
                        && !trimmed.starts_with("NS")
                        && !trimmed.starts_with("_NS")
                        && !trimmed.contains("AttributeName")
                    {
                        let filtered: String =
                            trimmed.chars().filter(|&c| c != '\u{FFFC}').collect();
                        if !filtered.is_empty() {
                            return Some(filtered);
                        } else {
                            return Some("[attachment]".to_string());
                        }
                    }
                }
            }
        }
    }

    None
}

/// Decode a variable-length integer used in Apple's typedstream format.
pub fn decode_length(data: &[u8]) -> Option<(usize, usize)> {
    let first = *data.first()?;

    if first < 0x80 {
        Some((1, first as usize))
    } else if first == 0x81 {
        let b1 = *data.get(1)? as usize;
        let b2 = *data.get(2)? as usize;
        Some((3, b1 | (b2 << 8)))
    } else if first == 0x82 {
        let b1 = *data.get(1)? as usize;
        let b2 = *data.get(2)? as usize;
        let b3 = *data.get(3)? as usize;
        Some((4, b1 | (b2 << 8) | (b3 << 16)))
    } else if first == 0x83 {
        let b1 = *data.get(1)? as usize;
        let b2 = *data.get(2)? as usize;
        let b3 = *data.get(3)? as usize;
        let b4 = *data.get(4)? as usize;
        Some((5, b1 | (b2 << 8) | (b3 << 16) | (b4 << 24)))
    } else {
        None
    }
}

// ============================================
// PHONE/EMAIL NORMALIZATION
// ============================================

/// Normalize a phone number to digits only.
#[pyfunction]
pub fn normalize_phone(phone: &str) -> String {
    phone.chars().filter(|c| c.is_numeric()).collect()
}

/// Normalize an email to lowercase.
#[pyfunction]
pub fn normalize_email(email: &str) -> String {
    email.to_lowercase()
}

/// Convert Apple timestamp (nanoseconds since 2001-01-01) to Unix timestamp.
#[pyfunction]
pub fn apple_to_unix(apple_timestamp: i64) -> i64 {
    let seconds_since_2001 = apple_timestamp / 1_000_000_000;
    seconds_since_2001 + 978307200
}

/// Get current Unix timestamp in seconds. (Internal use only)
pub fn now_timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    // normalize_phone tests
    #[test]
    fn test_normalize_phone_with_dashes() {
        assert_eq!(normalize_phone("555-123-4567"), "5551234567");
    }

    #[test]
    fn test_normalize_phone_with_parens() {
        assert_eq!(normalize_phone("(555) 123-4567"), "5551234567");
    }

    #[test]
    fn test_normalize_phone_international() {
        assert_eq!(normalize_phone("+1 (555) 123-4567"), "15551234567");
    }

    #[test]
    fn test_normalize_phone_empty() {
        assert_eq!(normalize_phone(""), "");
    }

    #[test]
    fn test_normalize_phone_with_dots() {
        assert_eq!(normalize_phone("555.123.4567"), "5551234567");
    }

    // normalize_email tests
    #[test]
    fn test_normalize_email_uppercase() {
        assert_eq!(normalize_email("ALICE@EXAMPLE.COM"), "alice@example.com");
    }

    #[test]
    fn test_normalize_email_mixed_case() {
        assert_eq!(
            normalize_email("Alice.Bob@Example.COM"),
            "alice.bob@example.com"
        );
    }

    #[test]
    fn test_normalize_email_empty() {
        assert_eq!(normalize_email(""), "");
    }

    // apple_to_unix tests
    #[test]
    fn test_apple_epoch() {
        assert_eq!(apple_to_unix(0), 978307200);
    }

    #[test]
    fn test_apple_to_unix_large_value() {
        // ~24 years after 2001 in nanoseconds
        let ns = 757_382_400_000_000_000_i64; // ~2025-01-01
        let unix = apple_to_unix(ns);
        assert!(unix > 1700000000); // Should be well after 2023
    }

    // now_timestamp tests
    #[test]
    fn test_now_timestamp_reasonable() {
        let ts = now_timestamp();
        // Should be after 2024-01-01 (1704067200) and before 2030-01-01 (1893456000)
        assert!(ts > 1704067200);
        assert!(ts < 1893456000);
    }
}
