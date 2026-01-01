//! Dumb data source for Apple Contacts via AppleScript.

use pyo3::prelude::*;
use std::process::Command;

use crate::models::FetchedContact;

const CONTACT_DELIMITER: &str = "<<<CONTACT>>>";

/// Fetch all contact names from Apple Contacts.
#[pyfunction]
pub fn fetch_all_contact_names() -> PyResult<Vec<String>> {
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
