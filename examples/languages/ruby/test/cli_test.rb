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

  def test_invalid_arguments
    [["256", "banana"], ["not-a-byte", "banana"], ["97"]].each do |args|
      output, error, status = invoke(*args)
      refute_predicate status, :success?
      assert_empty output
      refute_empty error
    end
  end

  private

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
