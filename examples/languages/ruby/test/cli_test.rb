# frozen_string_literal: true

require "test_helper"
require "open3"
require "rbconfig"

class CliTest < Minitest::Test
  parallelize_me!

  def test_executable
    output, error, status = Open3.capture3(RbConfig.ruby, "-Ilib", "bin/count", "97", "banana")
    assert_predicate status, :success?
    assert_empty error
    assert_equal "3\n", output
  end

  def test_invalid_arguments
    [["256", "banana"], ["not-a-byte", "banana"], ["97"]].each do |args|
      output, error, status = Open3.capture3(RbConfig.ruby, "-Ilib", "bin/count", *args)
      refute_predicate status, :success?
      assert_empty output
      refute_empty error
    end
  end
end
