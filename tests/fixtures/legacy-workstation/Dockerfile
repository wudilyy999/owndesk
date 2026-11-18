ARG WORKSTATION_IMAGE
FROM ${WORKSTATION_IMAGE}

# Keep the real desktop startup/readiness path; only the health contract is legacy.
COPY protocol4-health.mjs /opt/owndesk-controller/server.mjs
