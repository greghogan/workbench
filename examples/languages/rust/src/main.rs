use std::process::ExitCode;

use clap::Parser;

/// Add two unsigned integers without wrapping on overflow.
#[derive(Parser)]
#[command(version)]
struct Args {
    /// First unsigned integer.
    left: u64,
    /// Second unsigned integer.
    right: u64,
}

fn main() -> ExitCode {
    let args = Args::parse();
    let Some(sum) = workbench_rust_reference::add(args.left, args.right) else {
        eprintln!("error: sum exceeds the maximum unsigned 64-bit integer");
        return ExitCode::FAILURE;
    };
    println!("{sum}");
    ExitCode::SUCCESS
}
