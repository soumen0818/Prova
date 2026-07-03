# Multi-stage build for the Prova backend.
FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod ./
# COPY go.sum ./   # uncomment once external deps are added
RUN go mod download || true
COPY . .
RUN CGO_ENABLED=0 go build -o /out/api ./cmd/api

FROM gcr.io/distroless/static-debian12
COPY --from=build /out/api /api
EXPOSE 8080
ENTRYPOINT ["/api"]
