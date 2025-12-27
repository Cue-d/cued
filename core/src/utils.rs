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

    #[test]
    fn test_normalize_phone_with_dashes() {
        assert_eq!(normalize_phone("555-123-4567"), "5551234567");
    }

    #[test]
    fn test_normalize_phone_with_parens() {
        assert_eq!(normalize_phone("(555) 123-4567"), "5551234567");
    }

    #[test]
    fn test_normalize_email_uppercase() {
        assert_eq!(normalize_email("ALICE@EXAMPLE.COM"), "alice@example.com");
    }

    #[test]
    fn test_apple_epoch() {
        assert_eq!(apple_to_unix(0), 978307200);
    }

    #[test]
    fn test_one_second_after_epoch() {
        assert_eq!(apple_to_unix(1_000_000_000), 978307201);
    }
}
