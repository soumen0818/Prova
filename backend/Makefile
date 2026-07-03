.PHONY: run build test vet tidy up down

run:
	go run ./cmd/api

build:
	go build -o bin/api ./cmd/api

test:
	go test ./...

vet:
	go vet ./...

tidy:
	go mod tidy

up:        ## start postgres + redis
	docker compose up -d

down:
	docker compose down
