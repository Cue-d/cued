pub fn normalize_phone(phone: &str) -> String {
    phone.chars()
        .filter(|c| c.is_numeric())
        .collect()
}

pub fn normalize_email(email: &str) -> String {
    email.to_lowercase()
}


// We need to instantiate a function to convert apple time to unix encoded time
pub fn apple_to_unix(apple_timestamp: i64) -> i64 {
    // Apple timestamp is in nanoseconds since 2001-01-01
    // Convert to seconds by dividing by 1_000_000_000
    let seconds_since_2001 = apple_timestamp / 1_000_000_000;
    
    // Add the offset to get Unix timestamp
    // 978307200 is seconds between Unix epoch (1970) and Apple epoch (2001)
    seconds_since_2001 + 978307200
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
    fn test_normalize_phone_with_dots() {
        assert_eq!(normalize_phone("555.123.4567"), "5551234567");
    }

    #[test]
    fn test_normalize_phone_with_plus_one() {
        assert_eq!(normalize_phone("+1 555 123 4567"), "15551234567");
    }

    #[test]
    fn test_normalize_phone_already_clean() {
        assert_eq!(normalize_phone("5551234567"), "5551234567");
    }

    #[test]
    fn test_normalize_phone_with_country_code() {
        assert_eq!(normalize_phone("+15551234567"), "15551234567");
    }

    #[test]
    fn test_normalize_email_uppercase() {
        assert_eq!(normalize_email("ALICE@EXAMPLE.COM"), "alice@example.com");
    }

    #[test]
    fn test_normalize_email_mixed_case() {
        assert_eq!(normalize_email("Alice@Example.COM"), "alice@example.com");
    }

    #[test]
    fn test_apple_epoch() {
        // Apple timestamp 0 = 2001-01-01 00:00:00
        assert_eq!(apple_to_unix(0), 978307200);
    }

    #[test]
    fn test_one_second_after_epoch() {
        // 1 second in nanoseconds
        assert_eq!(apple_to_unix(1_000_000_000), 978307201);
    }

    #[test]
    fn test_recent_timestamp() {
        // Approximate: Dec 18, 2025 (today-ish)
        // This is roughly 787,536,000 seconds after 2001
        let apple_ns = 787_536_000_000_000_000i64;
        let unix = apple_to_unix(apple_ns);
        assert_eq!(unix, 1765843200); // ~Dec 2025
    }
}

