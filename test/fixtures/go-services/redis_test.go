package services

import (
	"bufio"
	"fmt"
	"net"
	"net/url"
	"testing"
	"time"
)

func TestRedisSetGet(t *testing.T) {
	u, err := url.Parse(mustEnv(t, "TEST_REDIS_URL"))
	if err != nil {
		t.Fatalf("parse TEST_REDIS_URL: %v", err)
	}
	conn, err := net.DialTimeout("tcp", u.Host, 5*time.Second)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer func() { _ = conn.Close() }()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	r := bufio.NewReader(conn)

	do := func(cmd string) string {
		t.Helper()
		if _, err := fmt.Fprint(conn, cmd); err != nil {
			t.Fatalf("write %q: %v", cmd, err)
		}
		line, err := r.ReadString('\n')
		if err != nil {
			t.Fatalf("read reply to %q: %v", cmd, err)
		}
		return line
	}

	if got := do("*3\r\n$3\r\nSET\r\n$2\r\nci\r\n$2\r\nok\r\n"); got != "+OK\r\n" {
		t.Fatalf("SET replied %q", got)
	}
	if got := do("*2\r\n$3\r\nGET\r\n$2\r\nci\r\n"); got != "$2\r\n" {
		t.Fatalf("GET replied %q", got)
	}
	if got, _ := r.ReadString('\n'); got != "ok\r\n" {
		t.Fatalf("GET value %q", got)
	}
}
