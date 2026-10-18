package org.example.workbench;

import java.nio.charset.StandardCharsets;
import java.util.Objects;

/** Counts unsigned bytes without depending on the host character encoding. */
public final class Count {
  public int countByte(byte[] data, int needle) {
    Objects.requireNonNull(data, "data");
    if (needle < 0 || needle > 255) {
      throw new IllegalArgumentException("needle must be a byte (0 through 255)");
    }
    int count = 0;
    for (byte value : data) {
      if ((value & 0xff) == needle) {
        count++;
      }
    }
    return count;
  }

  public static void main(String[] args) {
    if (args.length != 2) {
      throw new IllegalArgumentException("usage: count BYTE TEXT");
    }
    int needle = Integer.parseInt(args[0]);
    System.out.println(new Count().countByte(args[1].getBytes(StandardCharsets.UTF_8), needle));
  }
}
