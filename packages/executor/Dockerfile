# Multi-stage build for the executor binary.
# Target: distroless (~8MB final image), AMD64 + ARM64.
FROM golang:1.26-alpine AS builder

WORKDIR /build
COPY go.mod ./
# No external deps — skip go mod download
COPY main.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o executor .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=builder /build/executor /executor

# Include basic tools for exec calls (sh, cat, ls, mkdir, chmod, etc.)
# distroless/static doesn't have these — use a busybox layer instead
FROM busybox:1.37-musl AS tools

FROM gcr.io/distroless/base-debian12:nonroot
COPY --from=builder /build/executor /executor
COPY --from=tools /bin/ /bin/
COPY --from=tools /usr/bin/ /usr/bin/

ENV EXECUTOR_PORT=8080
EXPOSE 8080

ENTRYPOINT ["/executor"]
