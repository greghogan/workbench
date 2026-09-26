/// Add two values.
///
/// ```
/// assert_eq!(workbench_rust_reference::add(2, 3), 5);
/// ```
#[must_use]
pub const fn add(left: u64, right: u64) -> u64 {
    left + right
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adds_values() {
        assert_eq!(add(2, 3), 5);
    }
}
