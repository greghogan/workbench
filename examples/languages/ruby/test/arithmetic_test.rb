# frozen_string_literal: true

require "test_helper"

class ArithmeticTest < Minitest::Test
  parallelize_me!

  def test_sum
    assert_equal 42, WorkbenchRubyReference.sum([20, 22])
    assert_equal 0, WorkbenchRubyReference.sum([])
    assert_equal(-1, WorkbenchRubyReference.sum([-3, 2]))
  end

  def test_count_byte
    assert_equal 3, WorkbenchRubyReference.count_byte("banana", 97)
    assert_equal 0, WorkbenchRubyReference.count_byte("", 97)
    assert_equal 2, WorkbenchRubyReference.count_byte("\x00\xff\x00".b, 0)
    assert_equal 1, WorkbenchRubyReference.count_byte("\xff".b, 255)
  end

  def test_byte_bounds
    [-1, 256].each do |byte|
      assert_raises(RangeError) { WorkbenchRubyReference.count_byte("banana", byte) }
    end
  end
end
