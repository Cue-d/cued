//! Dumb data source for Apple Contacts via AppleScript.

use pyo3::prelude::*;
use std::process::Command;

use crate::models::{FetchedContact, SyncedContact};

const CONTACT_DELIMITER: &str = "<<<CONTACT>>>";

/// Fetch all contact names from Apple Contacts.
#[pyfunction]
pub fn fetch_all_contact_names() -> PyResult<Vec<String>> {
    let script = r#"
        tell application "Contacts"
            launch
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
        .map_err(|e| {
            pyo3::exceptions::PyRuntimeError::new_err(format!("osascript failed: {}", e))
        })?;

    let output_str = String::from_utf8(output.stdout)
        .map_err(|e| pyo3::exceptions::PyValueError::new_err(format!("Invalid UTF-8: {}", e)))?;

    let cleaned = output_str
        .trim()
        .trim_start_matches('{')
        .trim_end_matches('}');
    let names: Vec<String> = cleaned
        .split(',')
        .map(|n| n.trim().trim_matches('"').to_string())
        .filter(|n| !n.is_empty())
        .collect();

    Ok(names)
}

/// Fetch contact details for a list of names.
#[pyfunction]
pub fn fetch_contacts_by_names(names: Vec<String>) -> PyResult<Vec<FetchedContact>> {
    if names.is_empty() {
        return Ok(Vec::new());
    }

    let names_list: String = names
        .iter()
        .map(|n| format!("\"{}\"", n.replace('"', "\\\"")))
        .collect::<Vec<_>>()
        .join(", ");

    let script = format!(
        r#"
        tell application "Contacts"
            launch
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
        .map_err(|e| {
            pyo3::exceptions::PyRuntimeError::new_err(format!("osascript failed: {}", e))
        })?;

    let output_str = String::from_utf8(output.stdout)
        .map_err(|e| pyo3::exceptions::PyValueError::new_err(format!("Invalid UTF-8: {}", e)))?;

    let mut contacts = Vec::new();
    for block in output_str.split(CONTACT_DELIMITER) {
        if let Some(contact) = parse_contact_block(block) {
            contacts.push(contact);
        }
    }

    Ok(contacts)
}

fn parse_contact_block(block: &str) -> Option<FetchedContact> {
    let mut name = String::new();
    let mut emails = Vec::new();
    let mut phones = Vec::new();
    let mut company = None;
    let mut notes = None;
    let mut has_data = false;

    for line in block
        .split('\r')
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
    {
        if let Some(value) = line.strip_prefix("NAME:") {
            name = value.trim().to_string();
            has_data = true;
        } else if let Some(value) = line.strip_prefix("COMPANY:") {
            let v = value.trim();
            if !v.is_empty() {
                company = Some(v.to_string());
            }
        } else if let Some(value) = line.strip_prefix("NOTE:") {
            let v = value.trim();
            if !v.is_empty() {
                notes = Some(v.to_string());
            }
        } else if let Some(value) = line.strip_prefix("EMAIL:") {
            let v = value.trim();
            if !v.is_empty() {
                emails.push(v.to_string());
            }
        } else if let Some(value) = line.strip_prefix("PHONE:") {
            let v = value.trim();
            if !v.is_empty() {
                phones.push(v.to_string());
            }
        }
    }

    if has_data && !name.is_empty() {
        Some(FetchedContact {
            name,
            emails,
            phones,
            company,
            notes,
        })
    } else {
        None
    }
}

/// Fetch all contacts with their Apple IDs and timestamps for incremental sync.
/// Returns all contacts with: id, name, emails, phones, company, notes, creation_date, modification_date
#[pyfunction]
pub fn fetch_all_contacts_for_sync() -> PyResult<Vec<SyncedContact>> {
    let script = format!(
        r#"
        tell application "Contacts"
            launch
            set output to ""
            repeat with aPerson in people
                try
                    set output to output & "ID:" & id of aPerson & return
                    set output to output & "NAME:" & name of aPerson & return
                    try
                        set output to output & "COMPANY:" & organization of aPerson & return
                    end try
                    try
                        set output to output & "NOTE:" & note of aPerson & return
                    end try
                    repeat with e in emails of aPerson
                        set output to output & "EMAIL:" & value of e & return
                    end repeat
                    repeat with ph in phones of aPerson
                        set output to output & "PHONE:" & value of ph & return
                    end repeat
                    -- Dates are returned as AppleScript date strings
                    set output to output & "CREATED:" & ((creation date of aPerson) as «class isot» as string) & return
                    set output to output & "MODIFIED:" & ((modification date of aPerson) as «class isot» as string) & return
                    set output to output & "{delimiter}" & return
                end try
            end repeat
            return output
        end tell
        "#,
        delimiter = CONTACT_DELIMITER,
    );

    let output = Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|e| {
            pyo3::exceptions::PyRuntimeError::new_err(format!("osascript failed: {}", e))
        })?;

    let output_str = String::from_utf8(output.stdout)
        .map_err(|e| pyo3::exceptions::PyValueError::new_err(format!("Invalid UTF-8: {}", e)))?;

    let mut contacts = Vec::new();
    for block in output_str.split(CONTACT_DELIMITER) {
        if let Some(contact) = parse_synced_contact_block(block) {
            contacts.push(contact);
        }
    }

    Ok(contacts)
}

/// Fetch contacts modified since a given timestamp.
/// This is the incremental sync function - only fetches contacts that changed.
#[pyfunction]
pub fn fetch_contacts_modified_since(since_timestamp: i64) -> PyResult<Vec<SyncedContact>> {
    // Convert Unix timestamp to AppleScript date format
    // AppleScript's «class isot» format is ISO 8601: "2025-01-05T12:00:00"
    let since_date = timestamp_to_applescript_date(since_timestamp);

    let script = format!(
        r#"
        tell application "Contacts"
            launch
            set cutoffDate to date "{since_date}"
            set output to ""
            repeat with aPerson in people
                try
                    if modification date of aPerson > cutoffDate then
                        set output to output & "ID:" & id of aPerson & return
                        set output to output & "NAME:" & name of aPerson & return
                        try
                            set output to output & "COMPANY:" & organization of aPerson & return
                        end try
                        try
                            set output to output & "NOTE:" & note of aPerson & return
                        end try
                        repeat with e in emails of aPerson
                            set output to output & "EMAIL:" & value of e & return
                        end repeat
                        repeat with ph in phones of aPerson
                            set output to output & "PHONE:" & value of ph & return
                        end repeat
                        set output to output & "CREATED:" & ((creation date of aPerson) as «class isot» as string) & return
                        set output to output & "MODIFIED:" & ((modification date of aPerson) as «class isot» as string) & return
                        set output to output & "{delimiter}" & return
                    end if
                end try
            end repeat
            return output
        end tell
        "#,
        since_date = since_date,
        delimiter = CONTACT_DELIMITER,
    );

    let output = Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|e| {
            pyo3::exceptions::PyRuntimeError::new_err(format!("osascript failed: {}", e))
        })?;

    let output_str = String::from_utf8(output.stdout)
        .map_err(|e| pyo3::exceptions::PyValueError::new_err(format!("Invalid UTF-8: {}", e)))?;

    let mut contacts = Vec::new();
    for block in output_str.split(CONTACT_DELIMITER) {
        if let Some(contact) = parse_synced_contact_block(block) {
            contacts.push(contact);
        }
    }

    Ok(contacts)
}

/// Get all Apple Contact IDs (for detecting deletions).
#[pyfunction]
pub fn fetch_all_contact_ids() -> PyResult<Vec<String>> {
    let script = r#"
        tell application "Contacts"
            launch
            set idList to {}
            repeat with aPerson in people
                try
                    set end of idList to id of aPerson
                end try
            end repeat
            return idList
        end tell
    "#;

    let output = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|e| {
            pyo3::exceptions::PyRuntimeError::new_err(format!("osascript failed: {}", e))
        })?;

    let output_str = String::from_utf8(output.stdout)
        .map_err(|e| pyo3::exceptions::PyValueError::new_err(format!("Invalid UTF-8: {}", e)))?;

    let cleaned = output_str
        .trim()
        .trim_start_matches('{')
        .trim_end_matches('}');
    let ids: Vec<String> = cleaned
        .split(',')
        .map(|id| id.trim().trim_matches('"').to_string())
        .filter(|id| !id.is_empty())
        .collect();

    Ok(ids)
}

fn parse_synced_contact_block(block: &str) -> Option<SyncedContact> {
    let mut apple_id = String::new();
    let mut name = String::new();
    let mut emails = Vec::new();
    let mut phones = Vec::new();
    let mut company = None;
    let mut notes = None;
    let mut apple_created_at: i64 = 0;
    let mut apple_modified_at: i64 = 0;
    let mut has_data = false;

    for line in block
        .split('\r')
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
    {
        if let Some(value) = line.strip_prefix("ID:") {
            apple_id = value.trim().to_string();
            has_data = true;
        } else if let Some(value) = line.strip_prefix("NAME:") {
            name = value.trim().to_string();
        } else if let Some(value) = line.strip_prefix("COMPANY:") {
            let v = value.trim();
            if !v.is_empty() {
                company = Some(v.to_string());
            }
        } else if let Some(value) = line.strip_prefix("NOTE:") {
            let v = value.trim();
            if !v.is_empty() {
                notes = Some(v.to_string());
            }
        } else if let Some(value) = line.strip_prefix("EMAIL:") {
            let v = value.trim();
            if !v.is_empty() {
                emails.push(v.to_string());
            }
        } else if let Some(value) = line.strip_prefix("PHONE:") {
            let v = value.trim();
            if !v.is_empty() {
                phones.push(v.to_string());
            }
        } else if let Some(value) = line.strip_prefix("CREATED:") {
            apple_created_at = parse_iso8601_timestamp(value.trim());
        } else if let Some(value) = line.strip_prefix("MODIFIED:") {
            apple_modified_at = parse_iso8601_timestamp(value.trim());
        }
    }

    if has_data && !apple_id.is_empty() && !name.is_empty() {
        Some(SyncedContact {
            id: 0, // Not yet in database; will be assigned on insert
            apple_id,
            name,
            emails,
            phones,
            company,
            notes,
            apple_created_at,
            apple_modified_at,
        })
    } else {
        None
    }
}

/// Parse ISO 8601 timestamp to Unix timestamp.
/// Format: "2025-01-05T12:00:00" -> Unix timestamp
///
/// TODO: This parser assumes timestamps are in UTC. Apple Contacts may return
/// timestamps in local time, which could cause off-by-hours errors for contacts
/// modified near the sync boundary. For incremental sync this is acceptable
/// since we'd just re-sync the contact on the next run.
fn parse_iso8601_timestamp(s: &str) -> i64 {
    // Try to parse ISO 8601 format: "2025-01-05T12:00:00"
    // We use a simple manual parser since we don't have chrono
    let s = s.trim();
    if s.is_empty() {
        return 0;
    }

    // Split date and time
    let parts: Vec<&str> = s.split('T').collect();
    if parts.len() != 2 {
        return 0;
    }

    // Parse date: "2025-01-05"
    let date_parts: Vec<&str> = parts[0].split('-').collect();
    if date_parts.len() != 3 {
        return 0;
    }
    let year: i64 = date_parts[0].parse().unwrap_or(0);
    let month: i64 = date_parts[1].parse().unwrap_or(0);
    let day: i64 = date_parts[2].parse().unwrap_or(0);

    // Parse time: "12:00:00"
    let time_parts: Vec<&str> = parts[1].split(':').collect();
    if time_parts.len() < 2 {
        return 0;
    }
    let hour: i64 = time_parts[0].parse().unwrap_or(0);
    let minute: i64 = time_parts[1].parse().unwrap_or(0);
    let second: i64 = time_parts.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);

    // Simple conversion to Unix timestamp (approximate, ignores leap seconds)
    // Days since Unix epoch (1970-01-01)
    let days_in_year = 365;
    let mut days: i64 = 0;

    // Years since 1970
    for y in 1970..year {
        days += if is_leap_year(y) { 366 } else { days_in_year };
    }

    // Months in current year
    let days_in_months = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    for m in 1..month {
        let month_days = days_in_months[(m - 1) as usize];
        days += month_days;
        if m == 2 && is_leap_year(year) {
            days += 1;
        }
    }

    // Days in current month
    days += day - 1;

    // Convert to seconds and add time
    days * 86400 + hour * 3600 + minute * 60 + second
}

fn is_leap_year(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0)
}

/// Convert Unix timestamp to AppleScript date string format.
/// AppleScript expects: "Saturday, January 4, 2025 at 12:00:00 AM"
fn timestamp_to_applescript_date(timestamp: i64) -> String {
    // Convert to simple date components
    let days_since_epoch = timestamp / 86400;
    let remaining_seconds = timestamp % 86400;
    let hours = remaining_seconds / 3600;
    let minutes = (remaining_seconds % 3600) / 60;
    let seconds = remaining_seconds % 60;

    // Calculate year, month, day from days since epoch
    let (year, month, day) = days_to_ymd(days_since_epoch);

    // Format as ISO 8601 for AppleScript parsing
    // AppleScript can parse this format: "2025-01-05 12:00:00"
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
        year, month, day, hours, minutes, seconds
    )
}

fn days_to_ymd(days_since_epoch: i64) -> (i64, i64, i64) {
    let mut remaining = days_since_epoch;
    let mut year = 1970;

    loop {
        let days_in_year = if is_leap_year(year) { 366 } else { 365 };
        if remaining < days_in_year {
            break;
        }
        remaining -= days_in_year;
        year += 1;
    }

    let days_in_months = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut month = 1;
    for (m, &base_days) in days_in_months.iter().enumerate() {
        let days_in_month = if m == 1 && is_leap_year(year) {
            base_days + 1
        } else {
            base_days
        };
        if remaining < days_in_month {
            break;
        }
        remaining -= days_in_month;
        month += 1;
    }

    let day = remaining + 1;
    (year, month, day)
}
