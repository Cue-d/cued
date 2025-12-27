pub mod app_db;
pub mod chat_reader;
pub mod contacts;
pub mod models;
pub mod utils;

use pyo3::prelude::*;

/// A simple test function exposed to Python
#[pyfunction]
fn normalize_phone(phone: &str) -> String {
    utils::normalize_phone(phone)
}

/// Python module - this is what Python will import as 'core'
#[pymodule]
fn core(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(normalize_phone, m)?)?;
    Ok(())
}