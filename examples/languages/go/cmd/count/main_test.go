package main

import (
	"bytes"
	"io"
	"testing"
)

type failedOutput struct{}

func (failedOutput) Write([]byte) (int, error) { return 0, io.ErrClosedPipe }

func TestOutputFailure(t *testing.T) {
	if code := run([]string{"a", "banana"}, failedOutput{}, io.Discard); code != 1 {
		t.Fatalf("failed output returned %d, want 1", code)
	}
}

func TestRun(t *testing.T) {
	for _, item := range []struct {
		name     string
		args     []string
		code     int
		out, err string
	}{
		{"count", []string{"a", "banana"}, 0, "3\n", ""},
		{"missing", nil, 2, "", "usage: count BYTE TEXT\n"},
		{"not a byte", []string{"ab", "banana"}, 2, "", "usage: count BYTE TEXT\n"},
	} {
		t.Run(item.name, func(t *testing.T) {
			var out, err bytes.Buffer
			code := run(item.args, &out, &err)
			if code != item.code || out.String() != item.out || err.String() != item.err {
				t.Fatalf("run = (%d, %q, %q), want (%d, %q, %q)", code, out.String(), err.String(), item.code, item.out, item.err)
			}
		})
	}
}
