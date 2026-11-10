package services

import (
	"context"
	"testing"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
)

func TestRabbitMQQuorumQueueWithDeadLetters(t *testing.T) {
	conn, err := amqp.Dial(mustEnv(t, "TEST_RABBITMQ_URL"))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer func() { _ = conn.Close() }()

	ch, err := conn.Channel()
	if err != nil {
		t.Fatalf("channel: %v", err)
	}
	if err := ch.Confirm(false); err != nil {
		t.Fatalf("confirm mode: %v", err)
	}

	if err := ch.ExchangeDeclare("ci.dlx", "fanout", true, false, false, false, nil); err != nil {
		t.Fatalf("declare dead-letter exchange: %v", err)
	}
	if _, err := ch.QueueDeclare("ci.dead", true, false, false, false, amqp.Table{"x-queue-type": "quorum"}); err != nil {
		t.Fatalf("declare dead-letter queue: %v", err)
	}
	if err := ch.QueueBind("ci.dead", "", "ci.dlx", false, nil); err != nil {
		t.Fatalf("bind dead-letter queue: %v", err)
	}
	if _, err := ch.QueueDeclare("ci.work", true, false, false, false, amqp.Table{
		"x-queue-type":           "quorum",
		"x-dead-letter-exchange": "ci.dlx",
	}); err != nil {
		t.Fatalf("declare quorum queue: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	confirm, err := ch.PublishWithDeferredConfirmWithContext(ctx, "", "ci.work", true, false, amqp.Publishing{Body: []byte("hello")})
	if err != nil {
		t.Fatalf("publish: %v", err)
	}
	if ok, err := confirm.WaitContext(ctx); err != nil || !ok {
		t.Fatalf("publisher confirm: ok=%v err=%v", ok, err)
	}

	msg, ok, err := ch.Get("ci.work", false)
	if err != nil || !ok {
		t.Fatalf("get from quorum queue: ok=%v err=%v", ok, err)
	}
	if err := msg.Nack(false, false); err != nil {
		t.Fatalf("nack: %v", err)
	}

	deadline := time.Now().Add(10 * time.Second)
	for {
		dead, ok, err := ch.Get("ci.dead", true)
		if err != nil {
			t.Fatalf("get from dead-letter queue: %v", err)
		}
		if ok {
			if string(dead.Body) != "hello" {
				t.Fatalf("dead-lettered body = %q", dead.Body)
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("the rejected message never reached the dead-letter queue")
		}
		time.Sleep(100 * time.Millisecond)
	}
}
