#[test]
fn public_api_is_available() {
    assert_eq!(workbench_rust_reference::add(20, 22), 42);
}
