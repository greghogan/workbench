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
    # Load the executable after coverage starts; Ruby compiles its main script before processing -r.
    coverage = if ENV["WORKBENCH_COVERAGE"] == "true"
                 ["-r", File.expand_path("coverage_helper.rb", __dir__), "-e",
                  "$PROGRAM_NAME = File.expand_path(ARGV.shift); load $PROGRAM_NAME"]
               else
                 []
               end
    Open3.capture3({ "WORKBENCH_COVERAGE_SUBPROCESS" => "true" }, RbConfig.ruby, "-Ilib", *coverage, "bin/count", *)
  end
end
