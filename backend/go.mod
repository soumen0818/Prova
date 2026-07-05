module github.com/prova/backend

go 1.25.0

require (
	github.com/jackc/pgx/v5 v5.10.0
	github.com/prova/shared v0.1.0
	github.com/redis/go-redis/v9 v9.21.0
	github.com/stellar/go v0.0.0-20251210100531-aab2ea4aca88
)

require (
	github.com/cespare/xxhash/v2 v2.3.0 // indirect
	github.com/jackc/pgpassfile v1.0.0 // indirect
	github.com/jackc/pgservicefile v0.0.0-20240606120523-5a60cdf6a761 // indirect
	github.com/jackc/puddle/v2 v2.2.2 // indirect
	github.com/klauspost/compress v1.17.6 // indirect
	github.com/pkg/errors v0.9.1 // indirect
	github.com/stellar/go-xdr v0.0.0-20231122183749-b53fb00bcac2 // indirect
	go.uber.org/atomic v1.11.0 // indirect
	golang.org/x/exp v0.0.0-20231006140011-7918f672742d // indirect
	golang.org/x/sync v0.18.0 // indirect
	golang.org/x/text v0.31.0 // indirect
)

// prova-shared is consumed from the local polyrepo checkout until it is published.
replace github.com/prova/shared => ../shared/go
