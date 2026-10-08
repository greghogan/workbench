package reference_test

import (
	"fmt"
	"testing"

	reference "example.com/workbench/go-reference"
)

func TestCountByte(t *testing.T) {
	for _, item := range []struct {
		name   string
		data   []byte
		needle byte
		want   int
	}{
		{"empty", nil, 0, 0},
		{"mixed", []byte("banana"), 'a', 3},
		{"high byte", []byte{255, 0, 255}, 255, 2},
	} {
		t.Run(item.name, func(t *testing.T) {
			if got := reference.CountByte(item.data, item.needle); got != item.want {
				t.Fatalf("CountByte(%v, %d) = %d, want %d", item.data, item.needle, got, item.want)
			}
		})
	}
}

func ExampleCountByte() {
	fmt.Println(reference.CountByte([]byte("banana"), 'a'))
	// Output: 3
}
