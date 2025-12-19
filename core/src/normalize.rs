pub fn normalize_phone(phone: &str) -> String {
    let digits: String = phone.chars()
        .filter(|c| c.is_numeric())
        .collect();
}

pub fn normalize_email(email: &str) -> String {
    email.to_lowercase()
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
        assert_eq!(normalize_phone("+1 555 123 4567"), "5551234567");
    }

    #[test]
    fn test_normalize_phone_already_clean() {
        assert_eq!(normalize_phone("5551234567"), "5551234567");
    }

    #[test]
    fn test_normalize_phone_with_country_code() {
        assert_eq!(normalize_phone("+15551234567"), "5551234567");
    }

    #[test]
    fn test_normalize_email_uppercase() {
        assert_eq!(normalize_email("ALICE@EXAMPLE.COM"), "alice@example.com");
    }

    #[test]
    fn test_normalize_email_mixed_case() {
        assert_eq!(normalize_email("Alice@Example.COM"), "alice@example.com");
    }
}