# frozen_string_literal: true

# Byte-oriented operations shared by the executable and library.
module WorkbenchRubyReference
  def self.sum(values)
    values.sum
  end

  def self.count_byte(data, byte)
    raise RangeError, "byte must be between 0 and 255" unless (0..255).cover?(byte)

    data.bytes.count(byte)
  end
end
