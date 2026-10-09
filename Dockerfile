# FleetWatch probe image. Built and scanned in GitHub Actions only.
#
# Stage 1 runs the unit tests and byte-compiles the package; the final stage
# copies only the compiled package onto a clean slim image, running as a
# numeric non-root user so Kubernetes can enforce runAsNonRoot.

FROM python:3.12-slim AS build
WORKDIR /src
ENV PYTHONDONTWRITEBYTECODE=1
COPY targets.yaml /targets.yaml
COPY probe/ ./
RUN python -m unittest discover -s tests -t . \
    && python -m compileall -q fleetwatch_probe

FROM python:3.12-slim
LABEL org.opencontainers.image.title="fleetwatch-probe" \
      org.opencontainers.image.description="HTTP uptime, latency and TLS expiry probe with Prometheus metrics" \
      org.opencontainers.image.source="https://github.com/naniiic137/fleetwatch" \
      org.opencontainers.image.licenses="LicenseRef-All-Rights-Reserved"
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    FW_TARGETS_FILE=/etc/fleetwatch/targets.yaml \
    FW_PORT=8080
WORKDIR /app
COPY --from=build /src/fleetwatch_probe ./fleetwatch_probe
COPY targets.yaml /etc/fleetwatch/targets.yaml
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["python", "-m", "fleetwatch_probe.healthcheck"]
ENTRYPOINT ["python", "-m", "fleetwatch_probe"]
