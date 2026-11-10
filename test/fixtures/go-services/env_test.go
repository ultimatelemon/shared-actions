package services

import (
	"os"
	"testing"
)

func mustEnv(t *testing.T, name string) string {
	t.Helper()
	v := os.Getenv(name)
	if v == "" {
		t.Fatalf("%s is not set; go-quality.yml sets it when the service is on", name)
	}
	return v
}
