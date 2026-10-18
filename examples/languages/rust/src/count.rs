//! Exact byte counting with an optional, runtime-checked AVX2 implementation.

/// Select an implementation without bypassing its CPU requirements.
#[derive(Clone, Copy, Debug)]
pub enum Backend {
    /// Select AVX2 when supported, otherwise use the scalar implementation.
    Auto,
    /// Portable reference implementation.
    Scalar,
    /// Require AVX2; return an error when unavailable.
    Avx2,
}

/// Whether this process can safely execute the AVX2 implementation.
#[must_use]
#[cfg(target_arch = "x86_64")]
pub fn avx2_available() -> bool {
    std::arch::is_x86_feature_detected!("avx2")
}

/// AVX2 is unavailable on non-x86 architectures.
#[must_use]
#[cfg(not(target_arch = "x86_64"))]
pub const fn avx2_available() -> bool {
    false
}

/// Count occurrences of a byte, including any partial vector at the end.
///
/// # Errors
/// Returns an error when explicitly requested AVX2 is unavailable.
///
/// ```
/// use workbench_rust_reference::count::{count_byte, Backend};
/// assert_eq!(count_byte(b"banana", b'a', Backend::Auto), Ok(3));
/// ```
#[allow(clippy::naive_bytecount)] // Deliberate portable oracle for the optional SIMD path.
pub fn count_byte(data: &[u8], needle: u8, backend: Backend) -> Result<usize, &'static str> {
    let vector = match backend {
        Backend::Scalar => false,
        Backend::Auto => avx2_available(),
        Backend::Avx2 if avx2_available() => true,
        Backend::Avx2 => return Err("AVX2 is unavailable"),
    };
    #[cfg(target_arch = "x86_64")]
    if vector {
        // SAFETY: the selection above checks AVX2 before entering the specialized function.
        return Ok(unsafe { count_avx2(data, needle) });
    }
    #[cfg(not(target_arch = "x86_64"))]
    let _ = vector;
    Ok(data.iter().filter(|&&value| value == needle).count())
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
#[allow(clippy::naive_bytecount)] // At most 31 bytes remain after vector processing.
unsafe fn count_avx2(data: &[u8], needle: u8) -> usize {
    use std::arch::x86_64::{
        _mm256_cmpeq_epi8, _mm256_loadu_si256, _mm256_movemask_epi8, _mm256_set1_epi8,
    };
    let target = _mm256_set1_epi8(i8::from_ne_bytes([needle]));
    let (chunks, remainder) = data.as_chunks::<32>();
    let mut total = 0;
    for chunk in chunks {
        // SAFETY: as_chunks guarantees 32 readable bytes; loadu permits unaligned addresses.
        let values = unsafe { _mm256_loadu_si256(chunk.as_ptr().cast()) };
        total += _mm256_movemask_epi8(_mm256_cmpeq_epi8(values, target)).count_ones() as usize;
    }
    total + remainder.iter().filter(|&&value| value == needle).count()
}
