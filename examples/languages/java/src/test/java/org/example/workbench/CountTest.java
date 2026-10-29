package org.example.workbench;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.parallel.ResourceLock;

final class CountTest {
  @Test
  void countsEmptyMixedAndUnsignedBytes() {
    Count counter = new Count();
    assertEquals(0, counter.countByte(new byte[0], 0));
    assertEquals(3, counter.countByte("banana".getBytes(StandardCharsets.UTF_8), 97));
    assertEquals(2, counter.countByte(new byte[] {(byte) 255, 0, (byte) 255}, 255));
    assertEquals(1, counter.countByte(new byte[] {(byte) 128, 127}, 128));
  }

  @Test
  void rejectsInvalidNeedlesAndNullInput() {
    Count counter = new Count();
    assertThrows(IllegalArgumentException.class, () -> counter.countByte(new byte[0], -1));
    assertThrows(IllegalArgumentException.class, () -> counter.countByte(new byte[0], 256));
    assertThrows(NullPointerException.class, () -> counter.countByte(null, 0));
  }

  @Test
  @ResourceLock("java.lang.System.out")
  void commandPrintsTheCountAndRejectsInvalidArguments() {
    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
    PrintStream original = System.out;
    try (PrintStream output = new PrintStream(bytes, true, StandardCharsets.UTF_8)) {
      System.setOut(output);
      Count.main(new String[] {"97", "banana"});
      assertEquals("3" + System.lineSeparator(), bytes.toString(StandardCharsets.UTF_8));
    } finally {
      System.setOut(original);
    }
    assertThrows(IllegalArgumentException.class, () -> Count.main(new String[0]));
    assertThrows(NumberFormatException.class, () -> Count.main(new String[] {"invalid", "banana"}));
    assertThrows(IllegalArgumentException.class, () -> Count.main(new String[] {"256", "banana"}));
  }
}
