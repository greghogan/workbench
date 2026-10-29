import { crc32, deflateRawSync } from "node:zlib";

// Construct ZIP headers directly so malformed declarations remain independent of the reader.
interface ZipEntry {
  name: string;
  content?: string;
  mode?: number;
  size?: number;
  comment?: string;
}
export function zip(entries: ZipEntry[]) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const { name, content = "", mode = 0o100755, size, comment = "" } of entries) {
    const filename = Buffer.from(name);
    const bytes = Buffer.from(content);
    const compressed = deflateRawSync(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(crc32(bytes), 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(size ?? bytes.length, 22);
    header.writeUInt16LE(filename.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(0x0314, 4);
    header.copy(directory, 6, 4, 30);
    directory.writeUInt16LE(Buffer.byteLength(comment), 32);
    directory.writeUInt32LE((mode << 16) >>> 0, 38);
    directory.writeUInt32LE(offset, 42);
    local.push(header, filename, compressed);
    central.push(directory, filename, Buffer.from(comment));
    offset += header.length + filename.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
