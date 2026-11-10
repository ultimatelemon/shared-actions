package goplain

import "testing"

func TestGreet(t *testing.T) {
	if got := Greet("lens"); got != "hello, lens" {
		t.Fatalf("Greet() = %q", got)
	}
}
