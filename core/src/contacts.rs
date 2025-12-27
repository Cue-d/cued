use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

const CONTACT_DELIMITER: &str = "<<<CONTACT>>>";

/// Contact data fetched from Apple Contacts via AppleScript
#[derive(Debug, Clone)]
pub struct FetchedContact {
    pub name: String,
    pub emails: Vec<String>,
    pub phones: Vec<String>,
    pub company: Option<String>,
    pub notes: Option<String>,
}

/// Step 1: Fetch all contact names (fast, one call)
pub fn fetch_all_contact_names() -> Result<Vec<String>, String> {
    let script = r#"
        tell application "Contacts"
            set nameList to {}
            repeat with aPerson in people
                try
                    set end of nameList to name of aPerson
                end try
            end repeat
            return nameList
        end tell
    "#;

    let output = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|e| format!("Failed to run osascript: {}", e))?;

    let output_str = String::from_utf8(output.stdout)
        .map_err(|e| format!("Invalid UTF-8 in output: {}", e))?;

    let cleaned = output_str.trim().trim_start_matches('{').trim_end_matches('}');
    let names: Vec<String> = cleaned
        .split(',')
        .map(|n| n.trim().trim_matches('"').to_string())
        .filter(|n| !n.is_empty())
        .collect();

    Ok(names)
}

/// Step 2: Fetch details for a batch of names in ONE AppleScript call
fn fetch_details_for_batch(names: &[String]) -> Result<Vec<FetchedContact>, String> {
    if names.is_empty() {
        return Ok(Vec::new());
    }

    // Build AppleScript list of names
    let names_list: String = names
        .iter()
        .map(|n| format!("\"{}\"", n.replace('"', "\\\"")))
        .collect::<Vec<_>>()
        .join(", ");

    let script = format!(
        r#"
        tell application "Contacts"
            set nameList to {{{names_list}}}
            set output to ""
            
            repeat with targetName in nameList
                try
                    set p to first person whose name is targetName
                    set output to output & "NAME:" & name of p & return
                    try
                        set output to output & "COMPANY:" & organization of p & return
                    end try
                    try
                        set output to output & "NOTE:" & note of p & return
                    end try
                    repeat with e in emails of p
                        set output to output & "EMAIL:" & value of e & return
                    end repeat
                    repeat with ph in phones of p
                        set output to output & "PHONE:" & value of ph & return
                    end repeat
                    set output to output & "{delimiter}" & return
                on error
                    -- Skip contacts that error
                end try
            end repeat
            
            return output
        end tell
        "#,
        names_list = names_list,
        delimiter = CONTACT_DELIMITER,
    );

    let output = Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|e| format!("Failed to run osascript: {}", e))?;

    let output_str = String::from_utf8(output.stdout)
        .map_err(|e| format!("Invalid UTF-8 in output: {}", e))?;

    // Parse contacts from output
    let mut contacts = Vec::new();
    for contact_block in output_str.split(CONTACT_DELIMITER) {
        if let Some(contact) = parse_contact_block(contact_block) {
            contacts.push(contact);
        }
    }

    Ok(contacts)
}

/// Fetch all contacts: names first, then details in batches
pub fn fetch_all_contacts_with_details<F>(
    batch_size: usize,
    mut on_progress: F,
) -> Result<Vec<FetchedContact>, String>
where
    F: FnMut(usize, usize), // (completed, total)
{
    // Step 1: Get all names
    let names = fetch_all_contact_names()?;
    let total = names.len();
    
    // Step 2: Fetch details in batches
    let mut all_contacts = Vec::new();
    
    for (batch_idx, chunk) in names.chunks(batch_size).enumerate() {
        match fetch_details_for_batch(chunk) {
            Ok(contacts) => all_contacts.extend(contacts),
            Err(e) => eprintln!("Error fetching batch {}: {}", batch_idx, e),
        }
        
        let completed = ((batch_idx + 1) * batch_size).min(total);
        on_progress(completed, total);
    }

    Ok(all_contacts)
}

/// Parse a single contact block from AppleScript output
fn parse_contact_block(block: &str) -> Option<FetchedContact> {
    let mut contact = FetchedContact {
        name: String::new(),
        emails: Vec::new(),
        phones: Vec::new(),
        company: None,
        notes: None,
    };

    let mut has_data = false;

    for line in block.split('\r').map(|l| l.trim()).filter(|l| !l.is_empty()) {
        if let Some(value) = line.strip_prefix("NAME:") {
            contact.name = value.trim().to_string();
            has_data = true;
        } else if let Some(value) = line.strip_prefix("COMPANY:") {
            let v = value.trim();
            if !v.is_empty() {
                contact.company = Some(v.to_string());
            }
        } else if let Some(value) = line.strip_prefix("NOTE:") {
            let v = value.trim();
            if !v.is_empty() {
                contact.notes = Some(v.to_string());
            }
        } else if let Some(value) = line.strip_prefix("EMAIL:") {
            let v = value.trim();
            if !v.is_empty() {
                contact.emails.push(v.to_string());
            }
        } else if let Some(value) = line.strip_prefix("PHONE:") {
            let v = value.trim();
            if !v.is_empty() {
                contact.phones.push(v.to_string());
            }
        }
    }

    if has_data && !contact.name.is_empty() {
        Some(contact)
    } else {
        None
    }
}

/// Get current Unix timestamp in seconds
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
    fn test_fetch_contact_names() {
        println!("\n🔄 Fetching all contact names...");
        let start = std::time::Instant::now();
        
        let names = fetch_all_contact_names().expect("Failed to fetch names");
        
        let elapsed = start.elapsed();
        println!("✅ Found {} contacts in {:?}", names.len(), elapsed);
        
        for name in names.iter().take(5) {
            println!("  - {}", name);
        }
    }

    #[test]
    #[ignore] // Run with: cargo test test_fetch_all -- --ignored --nocapture
    fn test_fetch_all_contacts_batched() {
        println!("\n🔄 Fetching ALL contacts with batched details...\n");
        let start = std::time::Instant::now();
        
        let contacts = fetch_all_contacts_with_details(50, |completed, total| {
            println!("  Progress: {}/{} ({:.0}%)", completed, total, 
                (completed as f64 / total as f64) * 100.0);
        }).expect("Failed to fetch contacts");
        
        let elapsed = start.elapsed();
        println!("\n✅ Fetched {} contacts in {:?}", contacts.len(), elapsed);
        println!("   That's {:.1}ms per contact", 
            elapsed.as_millis() as f64 / contacts.len().max(1) as f64);
        
        // Print first 10
        println!("\nFirst 10 contacts:");
        for c in contacts.iter().take(10) {
            println!("  - {} | emails: {} | phones: {}", 
                c.name, c.emails.len(), c.phones.len());
        }
        
        assert!(!contacts.is_empty(), "Expected at least one contact");
    }
}

