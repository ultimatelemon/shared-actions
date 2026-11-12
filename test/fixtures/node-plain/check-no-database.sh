if env | grep -E '^(TEST_)?DATABASE_URL='; then
  echo "::error::database variables are set without postgres-image"
  exit 1
fi
if getent hosts postgres; then
  echo "::error::a postgres service started from an empty image"
  exit 1
fi
