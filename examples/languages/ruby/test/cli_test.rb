# frozen_string_literal: true

require "test_helper"
require "open3"
require "rbconfig"

class CliTest < Minitest::Test
  parallelize_me!

  def test_executable
    output, error, status = invoke("97", "banana")
    assert_predicate status, :success?
    assert_empty error
    assert_equal "3\n", output
  end

  def test_rejects_out_of_range_byte
    assert_invalid(%w[256 banana], /byte must be between 0 and 255/)
  end

  def test_rejects_non_integer_byte
    assert_invalid(%w[not-a-byte banana], /invalid value for Integer.*not-a-byte/)
  end

  def test_requires_two_arguments
    assert_invalid(["97"], /expected BYTE and DATA/)
  end

  private

  def assert_invalid(args, diagnostic)
    output, error, status = invoke(*args)
    assert_equal 2, status.exitstatus
    assert_empty output
    assert_match diagnostic, error
  end

  def invoke(*)
    # Add load paths after Ruby startup; -I can transcode Unicode working directories on Windows.
    coverage = ENV["WORKBENCH_COVERAGE"] == "true" ? ["-r", "./test/coverage_helper"] : []
    loader = '$LOAD_PATH.unshift(File.expand_path("lib")); ' \
             "$PROGRAM_NAME = File.expand_path(ARGV.shift); load $PROGRAM_NAME"
    Open3.capture3(
      { "WORKBENCH_COVERAGE_SUBPROCESS" => "true" },
      RbConfig.ruby,
      *coverage,
      "-e", loader, "bin/count", *
    )
  end
end
