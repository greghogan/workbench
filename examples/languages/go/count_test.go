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

func BenchmarkCountByte(b *testing.B) {
	data := make([]byte, 64*1024)
	for index := range data {
		data[index] = byte(index % 251)
	}
	b.SetBytes(int64(len(data)))
	b.ResetTimer()
	for b.Loop() {
		if got := reference.CountByte(data, 97); got != 261 {
			b.Fatalf("CountByte benchmark produced %d; want 261", got)
		}
	}
}
