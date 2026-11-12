set -eu
[ "$DATABASE_URL" = "$TEST_DATABASE_URL" ]
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -c 'CREATE TABLE ci_check (id int); DROP TABLE ci_check;'
