use std::io;
use std::process::{Command, Output};

fn run(args: &[&str]) -> io::Result<Output> {
    Command::new(env!("CARGO_BIN_EXE_rust-reference"))
        .args(args)
        .env_remove("CLICOLOR_FORCE")
        .env("NO_COLOR", "1")
        .output()
}

#[test]
fn prints_the_sum() -> io::Result<()> {
    let output = run(&["20", "22"])?;
    assert!(output.status.success());
    assert_eq!(output.stdout, b"42\n");
    assert_eq!(output.stderr, b"");
    Ok(())
}

#[test]
fn rejects_invalid_operands() -> io::Result<()> {
    for (args, operand) in [(["invalid", "2"], "LEFT"), (["1", "invalid"], "RIGHT")] {
        let output = run(&args)?;
        assert_eq!(output.status.code(), Some(2));
        assert_eq!(output.stdout, b"");
        let diagnostic = String::from_utf8_lossy(&output.stderr);
        assert_eq!(
            diagnostic.lines().next(),
            Some(
                format!(
                    "error: invalid value 'invalid' for '<{operand}>': invalid digit found in string"
                )
                .as_str()
            )
        );
    }
    Ok(())
}

#[test]
fn rejects_overflow_without_printing_a_result() -> io::Result<()> {
    let output = run(&[&u64::MAX.to_string(), "1"])?;
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(output.stdout, b"");
    assert_eq!(
        output.stderr,
        b"error: sum exceeds the maximum unsigned 64-bit integer\n"
    );
    Ok(())
}
