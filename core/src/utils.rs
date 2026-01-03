//! Utility functions - some exposed to Python.

use pyo3::prelude::*;
use std::time::{SystemTime, UNIX_EPOCH};

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
