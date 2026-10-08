pub mod count;

/// Add two values, returning `None` if their sum exceeds [`u64::MAX`].
///
/// ```
/// assert_eq!(workbench_rust_reference::add(2, 3), Some(5));
/// assert_eq!(workbench_rust_reference::add(u64::MAX, 0), Some(u64::MAX));
/// assert_eq!(workbench_rust_reference::add(u64::MAX, 1), None);
/// ```
#[must_use]
pub const fn add(left: u64, right: u64) -> Option<u64> {
    left.checked_add(right)
}
