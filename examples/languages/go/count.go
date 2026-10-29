// Package reference provides an exact byte-counting example.
package reference

import "bytes"

// CountByte counts needle in data, treating every byte as an unsigned value.
func CountByte(data []byte, needle byte) int {
	return bytes.Count(data, []byte{needle})
}
