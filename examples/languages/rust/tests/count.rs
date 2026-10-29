use workbench_rust_reference::count::{Backend, avx2_available, count_byte};

#[test]
fn every_backend_preserves_counts_at_vector_boundaries() {
    for offset in 0..32 {
        for length in [0, 1, 31, 32, 33, 63, 64, 65] {
            // Put the tail at the allocation boundary so Miri can detect even a one-byte overread.
            let data: Box<[u8]> = (0..offset + length)
                .map(|index| if index % 3 == 0 { 255 } else { 0 })
                .collect();
            let slice = &data[offset..offset + length];
            let expected = (offset..offset + length)
                .filter(|index| index % 3 == 0)
                .count();
            for backend in [Backend::Scalar, Backend::Auto, Backend::Avx2] {
                if matches!(backend, Backend::Avx2) && !avx2_available() {
                    continue;
                }
                assert_eq!(count_byte(slice, 255, backend), Ok(expected));
                assert_eq!(count_byte(slice, 0, backend), Ok(length - expected));
                assert_eq!(count_byte(slice, 1, backend), Ok(0));
            }
        }
    }
    println!("AVX2 execution available: {}", avx2_available());
}

#[test]
fn forced_avx2_respects_host_capabilities() {
    let result = count_byte(&[42; 64], 42, Backend::Avx2);
    if avx2_available() {
        assert_eq!(result, Ok(64));
    } else {
        assert_eq!(result, Err("AVX2 is unavailable"));
    }
}
