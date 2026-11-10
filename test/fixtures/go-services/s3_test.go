package services

import (
	"bytes"
	"context"
	"crypto/rand"
	"io"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

func TestS3PutGet(t *testing.T) {
	client := s3.New(s3.Options{
		BaseEndpoint: aws.String(mustEnv(t, "TEST_S3_ENDPOINT")),
		Region:       mustEnv(t, "TEST_S3_REGION"),
		Credentials: credentials.NewStaticCredentialsProvider(
			mustEnv(t, "TEST_S3_ACCESS_KEY_ID"), mustEnv(t, "TEST_S3_SECRET_ACCESS_KEY"), ""),
		UsePathStyle: true,
	})
	bucket := mustEnv(t, "TEST_S3_BUCKET")

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if _, err := client.HeadBucket(ctx, &s3.HeadBucketInput{Bucket: &bucket}); err != nil {
		t.Fatalf("the workflow should have created bucket %q: %v", bucket, err)
	}

	body := make([]byte, 8<<20)
	_, _ = rand.Read(body)
	key := "ci/object"
	if _, err := client.PutObject(ctx, &s3.PutObjectInput{Bucket: &bucket, Key: &key, Body: bytes.NewReader(body)}); err != nil {
		t.Fatalf("put: %v", err)
	}

	out, err := client.GetObject(ctx, &s3.GetObjectInput{Bucket: &bucket, Key: &key})
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer func() { _ = out.Body.Close() }()
	got, err := io.ReadAll(out.Body)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if !bytes.Equal(got, body) {
		t.Fatalf("got %d bytes back, not the %d that were put", len(got), len(body))
	}
}
