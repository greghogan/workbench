package reference_test

import (
	"testing"

	reference "example.com/workbench/go-reference"
)

// The literal loop is an independent oracle for the library-backed implementation.
func FuzzCountByte(f *testing.F) {
	f.Add([]byte("banana"), byte('a'))
	f.Add([]byte{}, byte(0))
	f.Add([]byte{255, 0, 255}, byte(255))
	f.Fuzz(func(t *testing.T, data []byte, needle byte) {
		want := 0
		for _, value := range data {
			if value == needle {
				want++
			}
		}
		if got := reference.CountByte(data, needle); got != want {
			t.Fatalf("CountByte(%x, %d) = %d; want %d", data, needle, got, want)
		}
	})
}
