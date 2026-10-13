// Command count counts a selected byte in a string.
package main

import (
	"fmt"
	"io"
	"os"

	reference "example.com/workbench/go-reference"
)

func run(args []string, stdout, stderr io.Writer) int {
	if len(args) != 2 || len(args[0]) != 1 {
		fmt.Fprintln(stderr, "usage: count BYTE TEXT")
		return 2
	}
	if _, err := fmt.Fprintln(stdout, reference.CountByte([]byte(args[1]), args[0][0])); err != nil {
		return 1
	}
	return 0
}

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}
