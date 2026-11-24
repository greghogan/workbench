package reference

import "bytes"

func CountByte(data []byte, needle byte) int {
	return bytes.Count(data, []byte{needle})
}
