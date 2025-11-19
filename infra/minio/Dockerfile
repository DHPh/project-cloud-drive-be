FROM golang:1.26-alpine AS build
ENV CGO_ENABLED=0
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go install -trimpath github.com/minio/minio@RELEASE.2025-10-15T17-29-55Z

FROM alpine:3.23
RUN addgroup -S minio && adduser -S -G minio minio \
    && mkdir /data && chown minio:minio /data
COPY --from=build /go/bin/minio /usr/local/bin/minio
USER minio
ENTRYPOINT ["/usr/local/bin/minio"]
